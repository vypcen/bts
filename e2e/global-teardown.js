module.exports = async () => {
  await globalThis.__E2E_SERVER__?.stop();
};
