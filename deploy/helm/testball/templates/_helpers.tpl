{{- define "testball.name" -}}{{ .Release.Name }}-testball{{- end -}}

{{- define "testball.labels" -}}
app.kubernetes.io/name: testball
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "testball.selector" -}}
app.kubernetes.io/name: testball
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "testball.secretName" -}}{{ .Values.secrets.existingSecret | default (printf "%s-secrets" (include "testball.name" .)) }}{{- end -}}
{{- define "testball.dbSecretName" -}}{{ .Values.database.existingSecret | default (printf "%s-db" (include "testball.name" .)) }}{{- end -}}
