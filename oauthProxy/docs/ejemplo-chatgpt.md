# ChatGPT y el proxy: el flujo y sus límites

En este proyecto, `llamaharness` ofrece herramientas mediante MCP y `oauthProxy` comprueba las credenciales antes de permitir el acceso. ChatGPT sirve para ilustrar el papel de un cliente remoto: el usuario autoriza desde su navegador y el cliente canjea el código y llama al MCP desde sus servidores.

Este capítulo aplica los conceptos de [OAuth](oauth.md) al código existente. El proxy es un prototipo local y todavía requiere cambios para admitir esa integración de forma segura.

## Las responsabilidades del proxy

El usuario decide conceder acceso a las herramientas y ChatGPT sería el cliente OAuth. El proxy actúa como servidor de autorización al emitir códigos y tokens, y controla el acceso al servidor de recursos antes de reenviar las peticiones a `llamaharness`.

```text
Cliente MCP → oauthProxy :9910 → llamaharness :9908
```

El backend se ejecuta sin API key y debe escuchar únicamente en loopback. El proxy también escucha en `127.0.0.1` por defecto. El usuario se identifica con una contraseña propia del proxy, configurada mediante un hash. Una contraseña válida crea una sesión bajo el sujeto fijo `local-user`.

## Del descubrimiento a la autorización

Una petición a `/mcp` sin credenciales válidas recibe un `401`. La cabecera `WWW-Authenticate` indica dónde consultar los metadatos del recurso protegido: `/.well-known/oauth-protected-resource`.

Esos metadatos identifican el recurso y anuncian sus servidores de autorización mediante `authorization_servers`. Después, el cliente consulta los metadatos del emisor, publicados aquí en `/.well-known/openid-configuration`, para conocer `/authorize`, `/token` y `/jwks.json`. Son dos consultas con funciones distintas.

Antes de abrir `/authorize` en el navegador, ChatGPT, como cliente, genera y conserva el verificador PKCE (`code_verifier`), un secreto aleatorio. Envía su hash como desafío `S256` y presenta el secreto al canjear el código. El usuario no necesita escribirlo ni recordarlo. También prepara un `state` para comprobar la respuesta. Una solicitud ilustrativa contiene:

```text
response_type=code
client_id=IDENTIFICADOR_DEL_CLIENTE
redirect_uri=DIRECCION_DE_RETORNO
scope=mcp:tools
state=VALOR_ALEATORIO
code_challenge=BASE64URL_SHA256_DEL_VERIFICADOR
code_challenge_method=S256
```

Los valores en mayúsculas son marcadores. No debe suponerse que ChatGPT utiliza literalmente `client_id=chatgpt`: puede identificarse mediante un cliente predefinido, registro dinámico (DCR) o documentos de metadatos de cliente (CIMD). La dirección de retorno debe tomarse de la configuración de la conexión. Véase la [guía oficial para conectar un MCP a ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server).

El proxy valida la solicitud y pide la contraseña si no hay una sesión activa. Después muestra «Autorizar acceso». Al aprobar, crea un código que caduca a los cinco minutos y redirige a la `redirect_uri` con `code` y `state`. La aprobación exige sesión y un token CSRF; una petición directa no puede saltarse el login.

El cliente predefinido es `chatgpt`, con retorno a `https://chatgpt.com/connector_platform_oauth_redirect`. El proxy anuncia soporte de RFC 9207 y devuelve `iss` con su emisor exacto en las respuestas de autorización, incluidos los errores. Esto permite a ChatGPT elegir el callback estable para una conexión nueva. Si una conexión existente conserva un callback particular, `OAUTH_REDIRECT_URI` permite configurarlo; `OAUTH_CLIENT_ID` cambia el ID. Cada cliente remoto solo puede regresar a su dirección exacta. Los clientes locales conservan el retorno al propio proxy o a HTTP de loopback.

## El canje y el acceso al MCP

Después de autorizar, el cliente comprueba el `state` y envía el código a `/token` mediante un formulario:

```http
POST /token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=CODIGO&code_verifier=VERIFICADOR&redirect_uri=URI_CODIFICADA&client_id=CLIENTE
```

Los valores deben codificarse como formulario. El campo `grant_type=authorization_code` es necesario para seleccionar el flujo. El proxy consume el código, comprueba su vigencia, la dirección de retorno y PKCE, y compara el `client_id` cuando se incluye. Incluso un canje fallido consume el código.

Una respuesta válida contiene un access token JWT firmado con `RS256`, un refresh token y la duración del acceso, que es de cinco minutos por defecto. No se emite un ID token ni se ofrece un inicio de sesión OIDC completo.

El cliente presenta `Authorization: Bearer <token>` en sus peticiones a `/mcp`. El proxy verifica firma, emisor, audiencia, caducidad y sujeto antes de reenviarlas. Elimina las credenciales del proxy al comunicarse con el backend. Aunque el token contiene un scope, actualmente no se comprueban permisos por herramienta.

## Renovación y sesiones

El cliente puede renovar el acceso enviando a `/token` un formulario con `grant_type=refresh_token`, `refresh_token` y `client_id`. El refresh token dura siete días y se reutiliza, sin rotación.

Los códigos, refresh tokens y sesiones se guardan en memoria y desaparecen al reiniciar. Fijar `SESSION_SECRET` no los hace persistentes. La llave de firma sí se conserva en disco: si se mantiene junto con la configuración, los JWT emitidos pueden seguir siendo válidos hasta caducar.

El flujo de `/oauth/login` crea una cookie `lh_session` para el navegador, útil para conexiones como `EventSource`. Cerrar esa sesión elimina su registro, pero no revoca los JWT ni los refresh tokens.

## Qué separa el prototipo de una conexión remota

`127.0.0.1` apunta a la máquina que realiza la petición. El navegador puede acceder al proxy local; los servidores de un cliente remoto no pueden alcanzar la computadora del usuario mediante esa dirección.

Una conexión remota necesita una URL accesible y HTTPS. `PROXY_PUBLIC_URL` permite anunciar esa URL y utilizarla como emisor, pero no crea un túnel. El proxy exige HTTPS fuera de loopback y protege el login con un límite de cinco intentos por dirección en quince minutos. La contraseña se ingresa únicamente en la página del proxy; ChatGPT recibe el token tras la aprobación.

La identificación del usuario y la configuración de un cliente remoto con callback exacto están implementadas. El proxy utiliza PKCE sin secreto de cliente y no implementa DCR ni CIMD. Todavía hay que aplicar permisos por scope.

También debe vincularse el parámetro `resource` con la audiencia del token, según la [documentación oficial de autenticación para MCP](https://developers.openai.com/plugins/build/auth). Hoy el proxy ignora `resource` y usa una audiencia fija, `llamaharness-local` por defecto.

La persistencia y revocación deben definirse para el servicio, y la conexión debe probarse con ChatGPT. Las pruebas locales verifican el prototipo en su entorno, no esa integración. El [README](../README.md) describe cómo ejecutar el entorno local.
