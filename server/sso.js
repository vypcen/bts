// Единый вход: OpenID Connect (OAuth 2.0), LDAP / Active Directory, Kerberos (через SPNEGO на обратном прокси).
// Пользователь из внешнего источника создаётся при первом входе. Роль и доступ к проектам могут браться из групп каталога/IdP.
// Монтируется на /api/auth (маршруты /oidc/start, /oidc/callback, /kerberos), ldapLogin вызывается из POST /api/auth/login.
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const { pool, tx } = require("./db");
const auth = require("./auth");
const seats = require("./seats");
const { broadcast } = require("./live");
const { wrap, HttpError } = require("./util");

const env = (k, d = "") => (process.env[k] ?? d).trim();
// Список групп: через «;». Если DN в списке нет (нет «=»), можно и через запятую
const list = (v) => v.split(v.includes("=") ? /[;\n]/ : /[;,\n]/).map((s) => s.trim()).filter(Boolean);

// ---------- общие настройки ----------
const cfg = {
  localLogin: env("LOCAL_LOGIN", "on") !== "off",
  defaultRole: ["tester", "developer", "viewer"].includes(env("SSO_DEFAULT_ROLE")) ? env("SSO_DEFAULT_ROLE") : "viewer",
  syncRole: env("SSO_SYNC_ROLE", "true") !== "false",
  // Группы → роли. Совпадение — по полному DN или по CN/имени группы, без учёта регистра
  groups: {
    admin: list(env("SSO_ADMIN_GROUPS")),
    tester: list(env("SSO_TESTER_GROUPS")),
    developer: list(env("SSO_DEVELOPER_GROUPS")),
    viewer: list(env("SSO_VIEWER_GROUPS")),
  },
  // Пускать только членов этих групп (пусто — всех, кого пустил каталог/IdP)
  required: list(env("SSO_REQUIRED_GROUPS")),
  // Доступ к проектам из групп: регулярное выражение с ключом проекта в 1-й группе и необязательной ролью во 2-й.
  // Пример: ^TB-([A-Z]{2,6})(?:-(tester|developer|viewer))?$  →  группа «TB-LK-tester» даёт роль тестировщика в проекте LK
  projectGroupRe: env("SSO_PROJECT_GROUP_RE") ? new RegExp(env("SSO_PROJECT_GROUP_RE"), "i") : null,
  // Связывать вход из каталога с существующей учётной записью с тем же логином
  linkByLogin: env("SSO_LINK_BY_LOGIN", "true") !== "false",
  reservedAdmin: env("ADMIN_LOGIN").toLowerCase(),
};

const oidc = {
  issuer: env("OIDC_ISSUER").replace(/\/+$/, ""),
  clientId: env("OIDC_CLIENT_ID"),
  clientSecret: env("OIDC_CLIENT_SECRET"),
  redirectUri: env("OIDC_REDIRECT_URI"),
  scopes: env("OIDC_SCOPES", "openid profile email"),
  loginClaim: env("OIDC_LOGIN_CLAIM", "preferred_username"),
  nameClaim: env("OIDC_NAME_CLAIM", "name"),
  groupsClaim: env("OIDC_GROUPS_CLAIM", "groups"),
  label: env("OIDC_LABEL", "Войти через SSO"),
};
oidc.enabled = Boolean(oidc.issuer && oidc.clientId);

const ldap = {
  url: env("LDAP_URL"),
  bindDn: env("LDAP_BIND_DN"),
  bindPassword: env("LDAP_BIND_PASSWORD"),
  baseDn: env("LDAP_BASE_DN"),
  // {{login}} — введённый логин (экранируется по RFC 4515)
  filter: env("LDAP_USER_FILTER", "(&(objectClass=person)(|(sAMAccountName={{login}})(userPrincipalName={{login}})(uid={{login}})))"),
  loginAttr: env("LDAP_LOGIN_ATTR", "sAMAccountName"),
  nameAttr: env("LDAP_NAME_ATTR", "displayName"),
  emailAttr: env("LDAP_EMAIL_ATTR", "mail"),
  groupAttr: env("LDAP_GROUP_ATTR", "memberOf"),
  // AD: учитывать вложенные группы (LDAP_MATCHING_RULE_IN_CHAIN)
  nested: env("LDAP_NESTED_GROUPS") === "true",
  groupBaseDn: env("LDAP_GROUP_BASE_DN"),
  startTls: env("LDAP_STARTTLS") === "true",
  tls: {
    rejectUnauthorized: env("LDAP_TLS_REJECT_UNAUTHORIZED", "true") !== "false",
    ...(env("LDAP_CA_FILE") ? { ca: [fs.readFileSync(env("LDAP_CA_FILE"))] } : {}),
  },
};
ldap.enabled = Boolean(ldap.url && ldap.baseDn);

// Kerberos: прокси (nginx + spnego, Apache mod_auth_gssapi, IIS ARR) проверяет билет и передаёт имя пользователя в заголовке.
// Чтобы заголовок нельзя было подделать, прокси добавляет общий секрет
const krb = {
  header: env("KERBEROS_USER_HEADER").toLowerCase(),
  groupsHeader: env("KERBEROS_GROUPS_HEADER").toLowerCase(),
  secret: env("KERBEROS_PROXY_SECRET"),
  label: env("KERBEROS_LABEL", "Войти через Windows (Kerberos)"),
};
krb.enabled = Boolean(krb.header && krb.secret);
if (krb.header && !krb.secret) console.warn("[sso] KERBEROS_USER_HEADER задан без KERBEROS_PROXY_SECRET — вход через Kerberos выключен");

// Что показывать на странице входа
const providers = () => ({
  local: cfg.localLogin,
  ldap: ldap.enabled,
  oidc: oidc.enabled ? { label: oidc.label } : null,
  kerberos: krb.enabled ? { label: krb.label } : null,
});

// ---------- группы и роли ----------
// «CN=TB-Admins,OU=Groups,DC=corp,DC=local» → ["cn=tb-admins,ou=groups,dc=corp,dc=local", "tb-admins"]
// Keycloak передаёт путь группы: «/QA/TB-Testers» → ещё и «tb-testers»
function groupNames(g) {
  const full = String(g).trim().toLowerCase();
  const cn = /^cn=([^,]+)/i.exec(full)?.[1];
  const leaf = full.startsWith("/") ? full.split("/").filter(Boolean).pop() : null;
  return [...new Set([full, cn, leaf].filter(Boolean))];
}
const inGroups = (groups, rules) => {
  const names = new Set(groups.flatMap(groupNames));
  return rules.some((r) => names.has(r.toLowerCase()));
};
function roleFromGroups(groups) {
  for (const role of ["admin", "tester", "developer", "viewer"]) if (inGroups(groups, cfg.groups[role])) return role;
  return null;
}
// [{key, role|null}] из групп по SSO_PROJECT_GROUP_RE
function projectsFromGroups(groups) {
  if (!cfg.projectGroupRe) return null;
  const out = new Map();
  for (const g of groups) {
    for (const name of groupNames(g)) {
      const m = cfg.projectGroupRe.exec(name);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const role = m[2] ? m[2].toLowerCase() : null;
      // из нескольких групп одного проекта берём самую сильную роль
      const rank = (r) => ["viewer", "developer", "tester"].indexOf(r);
      if (!out.has(key) || rank(role) > rank(out.get(key))) out.set(key, role);
    }
  }
  return out;
}

// «CORP\ivanov», «ivanov@CORP.LOCAL» → «ivanov»; недопустимые символы → «_»
function normalizeLogin(raw, keepDomain = false) {
  let s = String(raw || "").trim();
  if (s.includes("\\")) s = s.split("\\").pop();
  if (!keepDomain && /@[^@]+$/.test(s) && env("SSO_KEEP_REALM") !== "true") s = s.replace(/@[^@]+$/, "");
  s = s.toLowerCase().replace(/[^a-z0-9._@-]/g, "_").slice(0, 64);
  return s.length >= 2 ? s : null;
}

// Найти или создать пользователя по данным внешнего источника. Возвращает {id, login, name, role}
async function provision({ provider, externalId, login, name, email = "", groups = [] }) {
  if (!login) throw new HttpError(403, "Источник входа не передал имя пользователя");
  if (cfg.required.length && !inGroups(groups, cfg.required)) throw new HttpError(403, "У вас нет доступа к TestBall: обратитесь к администратору");
  const mapped = roleFromGroups(groups);
  const projects = projectsFromGroups(groups);
  const user = await tx(async (db) => {
    let { rows } = await db.query("SELECT id, login, name, role, blocked FROM users WHERE auth_provider=$1 AND external_id=$2", [provider, externalId]);
    let u = rows[0];
    if (!u && cfg.linkByLogin) {
      ({ rows } = await db.query("SELECT id, login, name, role, blocked FROM users WHERE login=$1", [login]));
      u = rows[0];
    }
    if (u) {
      if (u.blocked) throw new HttpError(403, "Учётная запись заблокирована. Обратитесь к администратору");
      // аварийный администратор из ADMIN_LOGIN не теряет роль из-за групп
      let role = u.role;
      if (mapped && cfg.syncRole && u.login !== cfg.reservedAdmin && mapped !== u.role) {
        const bad = await seats.check(db, mapped, u.id);
        if (!bad) role = mapped;
        else console.warn(`[sso] ${u.login}: роль ${mapped} не выдана — ${bad}`);
      }
      await db.query(
        `UPDATE users SET name=COALESCE(NULLIF($1,''), name), email=COALESCE(NULLIF($2,''), email), role=$3,
           auth_provider=$4, external_id=$5, last_login_at=now() WHERE id=$6`,
        [name, email, role, provider, externalId, u.id]
      );
      u = { ...u, role, name: name || u.name };
    } else {
      let role = mapped || cfg.defaultRole;
      if (await seats.check(db, role)) {
        // полные места кончились — пускаем с просмотровой лицензией, если она есть
        role = "viewer";
        const bad = await seats.check(db, role);
        if (bad) throw new HttpError(403, bad);
      }
      // логин мог быть занят: добавляем числовой суффикс
      let candidate = login;
      for (let i = 2; ; i++) {
        const r = await db.query(
          `INSERT INTO users(login, name, email, password_hash, role, auth_provider, external_id, last_login_at)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,now()) ON CONFLICT (login) DO NOTHING RETURNING id`,
          [candidate, name || candidate, email, role, provider, externalId]
        );
        if (r.rows[0]) {
          u = { id: r.rows[0].id, login: candidate, name: name || candidate, role };
          break;
        }
        if (i > 50) throw new HttpError(409, "Не удалось подобрать свободный логин");
        candidate = `${login.slice(0, 60)}${i}`;
      }
    }
    if (projects) {
      // состав проектов задаёт каталог: лишние членства снимаем, недостающие добавляем
      const keys = [...projects.keys()];
      await db.query("DELETE FROM project_members WHERE user_id=$1 AND NOT (project_key = ANY($2::text[]))", [u.id, keys]);
      for (const [key, role] of projects) {
        await db.query(
          `INSERT INTO project_members(project_key, user_id, role) SELECT key, $2, $3 FROM projects WHERE key=$1
           ON CONFLICT (project_key, user_id) DO UPDATE SET role=EXCLUDED.role`,
          [key, u.id, role]
        );
      }
    }
    return u;
  });
  broadcast("users");
  return user;
}

// ---------- LDAP / Active Directory ----------
// RFC 4515: значения в фильтре экранируются, иначе логин «*)(uid=*» подобрал бы чужую учётную запись
const escapeFilter = (s) => s.replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x)));

async function ldapClient() {
  const { Client } = require("ldapts");
  const client = new Client({ url: ldap.url, timeout: 10000, connectTimeout: 10000, tlsOptions: ldap.tls });
  if (ldap.startTls) await client.startTLS(ldap.tls);
  return client;
}

// Найти пользователя в каталоге (служебной учётной записью). null — не найден или найдено несколько
async function ldapFind(client, login) {
  if (ldap.bindDn) await client.bind(ldap.bindDn, ldap.bindPassword);
  const { searchEntries } = await client.search(ldap.baseDn, {
    scope: "sub",
    filter: ldap.filter.replaceAll("{{login}}", escapeFilter(login)),
    attributes: [ldap.loginAttr, ldap.nameAttr, ldap.emailAttr, ldap.groupAttr, "objectGUID", "entryUUID"],
    explicitBufferAttributes: ["objectGUID"],
    sizeLimit: 2,
  });
  if (searchEntries.length !== 1) return null;
  const e = searchEntries[0];
  let groups = asList(e[ldap.groupAttr]);
  if (ldap.nested) {
    const r = await client.search(ldap.groupBaseDn || ldap.baseDn, {
      scope: "sub", filter: `(member:1.2.840.113556.1.4.1941:=${escapeFilter(e.dn)})`, attributes: ["dn"],
    });
    groups = [...new Set([...groups, ...r.searchEntries.map((g) => g.dn)])];
  }
  const guid = first(e.objectGUID);
  return {
    dn: e.dn,
    externalId: Buffer.isBuffer(guid) ? guid.toString("hex") : String(first(e.entryUUID) || e.dn).toLowerCase(),
    login: normalizeLogin(first(asList(e[ldap.loginAttr])) || login),
    name: String(first(asList(e[ldap.nameAttr])) || "").slice(0, 100),
    email: String(first(asList(e[ldap.emailAttr])) || "").slice(0, 200),
    groups,
  };
}

// Проверить логин и пароль в каталоге. null — неверные данные или пользователя нет
async function ldapLogin(rawLogin, password) {
  if (!ldap.enabled || !password) return null;
  const login = String(rawLogin).includes("\\") ? String(rawLogin).split("\\").pop() : String(rawLogin);
  const client = await ldapClient();
  try {
    const found = await ldapFind(client, login);
    if (!found) return null;
    await client.unbind().catch(() => {});
    const check = await ldapClient();
    try {
      await check.bind(found.dn, password);
    } catch (e) {
      if (e.name === "InvalidCredentialsError" || e.code === 49) return null;
      throw e;
    } finally {
      await check.unbind().catch(() => {});
    }
    return provision({ provider: "ldap", ...found });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("[sso] LDAP:", e.message);
    throw new HttpError(503, "Каталог LDAP недоступен. Повторите позже или обратитесь к администратору");
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Данные пользователя из каталога без пароля (для входа через Kerberos)
async function ldapLookup(login) {
  if (!ldap.enabled) return null;
  const client = await ldapClient();
  try {
    return await ldapFind(client, login);
  } catch (e) {
    console.error("[sso] LDAP lookup:", e.message);
    return null;
  } finally {
    await client.unbind().catch(() => {});
  }
}

// ---------- OpenID Connect ----------
let discovery = null;
const jwks = { keys: null, at: 0 };

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || !json) throw new Error(`${url}: ${res.status} ${(json?.error_description || json?.error || text).toString().slice(0, 200)}`);
  return json;
}

async function oidcConfig() {
  if (!discovery || Date.now() - discovery.at > 3600e3) {
    discovery = { ...(await getJson(`${oidc.issuer}/.well-known/openid-configuration`)), at: Date.now() };
  }
  return discovery;
}

async function signingKey(kid, force = false) {
  if (!jwks.keys || force || Date.now() - jwks.at > 3600e3) {
    jwks.keys = (await getJson((await oidcConfig()).jwks_uri)).keys || [];
    jwks.at = Date.now();
  }
  const jwk = jwks.keys.find((k) => (!kid || k.kid === kid) && (k.use || "sig") === "sig");
  if (!jwk && !force) return signingKey(kid, true); // IdP мог сменить ключи
  return jwk ? crypto.createPublicKey({ key: jwk, format: "jwk" }) : null;
}

const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const ALGS = { RS256: "sha256", RS384: "sha384", RS512: "sha512", PS256: "sha256", PS384: "sha384", PS512: "sha512", ES256: "sha256", ES384: "sha384", ES512: "sha512" };

async function verifyIdToken(token, nonce) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("id_token повреждён");
  const header = b64json(h);
  const hash = ALGS[header.alg];
  if (!hash) throw new Error(`Алгоритм подписи ${header.alg} не поддерживается`);
  const key = await signingKey(header.kid);
  if (!key) throw new Error("Ключ подписи IdP не найден");
  const opts = { key };
  if (header.alg.startsWith("PS")) Object.assign(opts, { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  if (header.alg.startsWith("ES")) opts.dsaEncoding = "ieee-p1363";
  if (!crypto.verify(hash, Buffer.from(`${h}.${p}`), opts, Buffer.from(s, "base64url"))) throw new Error("Подпись id_token не прошла проверку");
  const claims = b64json(p);
  const now = Date.now() / 1000;
  const issuer = (await oidcConfig()).issuer || oidc.issuer;
  if (claims.iss !== issuer) throw new Error("id_token выпущен другим IdP");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(oidc.clientId)) throw new Error("id_token выпущен для другого приложения");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("Срок id_token истёк");
  if (claims.nonce !== nonce) throw new Error("nonce не совпадает");
  return claims;
}

// «realm_access.roles» — вложенное поле
const claim = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const redirectUri = (req) => oidc.redirectUri || `${req.protocol}://${req.get("host")}/api/auth/oidc/callback`;
// Возвращаться можно только на страницы этого же приложения
const safeReturn = (v) => (typeof v === "string" && /^\/(?!\/)[^\s\\]*$/.test(v) ? v.slice(0, 500) : "/");
const fail = (res, msg) => res.redirect(`/?sso_error=${encodeURIComponent(msg)}`);

const router = express.Router();

router.get("/providers", (_req, res) => res.json(providers()));

router.get("/oidc/start", wrap(async (req, res) => {
  if (!oidc.enabled) return res.status(404).json({ error: "Вход через OpenID Connect не настроен" });
  const conf = await oidcConfig();
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await pool.query("DELETE FROM auth_states WHERE created_at < now() - interval '15 minutes'");
  await pool.query("INSERT INTO auth_states(state, nonce, verifier, return_to) VALUES ($1,$2,$3,$4)", [state, nonce, verifier, safeReturn(req.query.return)]);
  const u = new URL(conf.authorization_endpoint);
  Object.entries({
    response_type: "code", client_id: oidc.clientId, redirect_uri: redirectUri(req), scope: oidc.scopes,
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  res.redirect(u.toString());
}));

router.get("/oidc/callback", wrap(async (req, res) => {
  if (!oidc.enabled) return fail(res, "Вход через OpenID Connect не настроен");
  if (req.query.error) return fail(res, `IdP отказал во входе: ${String(req.query.error_description || req.query.error).slice(0, 200)}`);
  const { rows } = await pool.query(
    "DELETE FROM auth_states WHERE state=$1 AND created_at > now() - interval '15 minutes' RETURNING nonce, verifier, return_to",
    [String(req.query.state || "")]
  );
  const st = rows[0];
  if (!st || typeof req.query.code !== "string") return fail(res, "Сессия входа устарела. Попробуйте ещё раз");
  try {
    const conf = await oidcConfig();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri(req), code_verifier: st.verifier });
    const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    const methods = conf.token_endpoint_auth_methods_supported || ["client_secret_basic"];
    if (!oidc.clientSecret) body.set("client_id", oidc.clientId);
    else if (methods.includes("client_secret_basic")) {
      headers.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`).toString("base64");
    } else {
      body.set("client_id", oidc.clientId);
      body.set("client_secret", oidc.clientSecret);
    }
    const tokens = await getJson(conf.token_endpoint, { method: "POST", headers, body });
    const claims = await verifyIdToken(tokens.id_token, st.nonce);
    // группы и имя часто есть только в userinfo
    let info = claims;
    if (conf.userinfo_endpoint && tokens.access_token && (claim(claims, oidc.groupsClaim) === undefined || !claim(claims, oidc.loginClaim))) {
      const extra = await getJson(conf.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).catch(() => ({}));
      if (extra.sub === claims.sub) info = { ...extra, ...claims };
    }
    const groups = claim(info, oidc.groupsClaim);
    const user = await provision({
      provider: "oidc",
      externalId: `${claims.iss}|${claims.sub}`,
      login: normalizeLogin(claim(info, oidc.loginClaim) || info.email || claims.sub, true),
      name: String(claim(info, oidc.nameClaim) || "").slice(0, 100),
      email: String(info.email || "").slice(0, 200),
      groups: Array.isArray(groups) ? groups.map(String) : typeof groups === "string" ? [groups] : [],
    });
    await auth.createSession(res, req, user.id);
    res.redirect(st.return_to || "/");
  } catch (e) {
    console.error("[sso] OIDC:", e.message);
    fail(res, e instanceof HttpError ? e.message : "Не удалось войти через SSO. Подробности в логах сервера");
  }
}));

// Kerberos (SPNEGO): этот адрес на прокси закрыт проверкой Negotiate, прокси передаёт имя пользователя и секрет
router.get("/kerberos", wrap(async (req, res) => {
  if (!krb.enabled) return fail(res, "Вход через Kerberos не настроен");
  const got = Buffer.from(req.get("x-auth-proxy-secret") || "");
  const want = Buffer.from(krb.secret);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return fail(res, "Запрос пришёл не через доверенный прокси Kerberos");
  const principal = String(req.get(krb.header) || "").trim();
  const login = normalizeLogin(principal);
  if (!login) return fail(res, "Прокси не передал имя пользователя Kerberos");
  try {
    const dir = await ldapLookup(login);
    const headerGroups = krb.groupsHeader ? String(req.get(krb.groupsHeader) || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [];
    const user = await provision({
      provider: "kerberos",
      externalId: principal.toLowerCase(),
      login: dir?.login || login,
      name: dir?.name || "",
      email: dir?.email || "",
      groups: [...(dir?.groups || []), ...headerGroups],
    });
    await auth.createSession(res, req, user.id);
    res.redirect(safeReturn(req.query.return));
  } catch (e) {
    console.error("[sso] Kerberos:", e.message);
    fail(res, e instanceof HttpError ? e.message : "Не удалось войти через Kerberos");
  }
}));

module.exports = { router, providers, ldapLogin, provision, cfg, normalizeLogin, roleFromGroups, escapeFilter };
