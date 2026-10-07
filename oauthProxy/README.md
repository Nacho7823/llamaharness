# llamaharness-oauth-proxy (local, sin IdP externo)

Proxy OAuth **auto-contenido** para `llamaharness` MCP. Emite y verifica sus propios
JWT (`RS256`) sin Google ni ningún proveedor externo. No hay fallback externo:
todo el código de este paquete es local.

El backend `llamaharness` se lanza **sin api-key** (abierto); este proxy es el
**único borde de seguridad** y solo habla con el backend por loopback.

```
[navegador / cliente MCP] -> proxy :9910 (OAuth local, único borde)
                                |
                                v loopback
                          llamaharness :9908 --host 127.0.0.1 (sin api-key)
```

## Arranque

```sh
# Terminal 1 — backend SIN api-key, solo loopback:
node ../llamatools/dist/llamaharness.js --transport http --host 127.0.0.1 --port 9908

# Terminal 2 — proxy (genera la llave RS256 en .keys/ al primer arranque):
cd oauthProxy && pnpm install
pnpm password:hash
# Ingresá una contraseña de al menos 12 caracteres (no se muestra al escribir).
# Copiá el hash completo que devuelve y exportalo entre comillas simples:
export OAUTH_PASSWORD_HASH='PEGAR_AQUI_EL_HASH_COMPLETO'
UPSTREAM_URL=http://127.0.0.1:9908 pnpm dev
# login browser: http://127.0.0.1:9910/oauth/login
```

> Si `UPSTREAM_URL` no es loopback (`127.0.0.1`/`localhost`/`::1`), el proxy
> aborta antes de escuchar. Es intencional: el backend sin key nunca debe exponerse.

## Reenvío con VS Code

En la pestaña **Ports / Puertos** de VS Code, reenviá el puerto **9910** y elegí
**Port Visibility → Public**. ChatGPT debe poder acceder sin iniciar sesión en
Microsoft. Copiá la URL HTTPS y arrancá el proxy desde `oauthProxy`:

```sh
pnpm dev:public https://TU_URL.devtunnels.ms
```

Este comando compila y arranca solo la app, con una contraseña aleatoria impresa
en la terminal. Usá la URL pública seguida de `/mcp` en ChatGPT. Para aplicar
cambios, detené la app y repetí el mismo comando; mantené el reenvío de VS Code
activo. El backend sigue ejecutándose por separado en loopback, puerto 9908.
`PROXY_PORT` permite elegir otro puerto si también cambiás el reenvío.

La URL del argumento tiene prioridad sobre `PROXY_PUBLIC_URL` y `.tunnel.json`.
También podés pasarla como variable de entorno. Este arranque no usa Tunnelmole.
Referencia: [reenvío de puertos de VS Code](https://code.visualstudio.com/docs/debugtest/port-forwarding).

## Arranque con Tunnelmole

Para mantener la dirección mientras reiniciás la app, usá dos terminales:

```sh
# Terminal 1: solo abre el túnel; dejala ejecutándose.
pnpm tunnel:open

# Terminal 2: arranca solo el proxy, con una contraseña aleatoria.
pnpm dev:tunnel
```

El túnel guarda su URL y puerto en `.tunnel.json`, sin contraseñas. Podés detener
la segunda terminal con Ctrl+C y volver a ejecutar `pnpm dev:tunnel`: usa la misma
dirección y genera otra contraseña. Mantené el backend ejecutándose por separado.
El túnel puede abrirse antes de la app. Si cerrás el túnel y abrís otro, la URL
puede cambiar; estos comandos no reservan un dominio permanente.

### Arranque conjunto

Con el backend ejecutándose, detené el proxy anterior y ejecutá:

```sh
pnpm tunnel
```

El [script](scripts/start-tmole.mjs) compila el proxy, genera una contraseña aleatoria,
abre un servidor temporal en el puerto 9910 para que `pnpx tmole 9910` pueda
comprobarlo, y lo reemplaza por el proxy con la URL HTTPS anunciada. El servidor
temporal responde únicamente “iniciando” (HTTP 503). Imprime la
contraseña y las direcciones de login y MCP. No hace falta configurar el hash ni
instalar Tunnelmole globalmente; se requieren `pnpm` y `pnpx`.

Cada arranque genera una contraseña nueva y usa su hash para el login, aunque ya
exista `OAUTH_PASSWORD_HASH` en la terminal. No guarda la contraseña en un archivo.
Con `Ctrl+C` cierra el proxy y el túnel; no inicia ni detiene el backend.
Puede ejecutarse desde cualquier directorio con
`node /ruta/al/proyecto/oauthProxy/scripts/start-tmole.mjs`.

`PROXY_PORT` cambia el puerto y `TMOLE_TIMEOUT_SEC` el tiempo máximo de espera
para recibir la URL (45 segundos por defecto). La interfaz permanece en loopback.
La URL puede cambiar al volver a abrir el túnel.

Para una conexión nueva con ChatGPT, basta con `pnpm tunnel`: el cliente por defecto
es `chatgpt` y su callback es `https://chatgpt.com/connector_platform_oauth_redirect`.
El proxy anuncia identificación del emisor (RFC 9207) e incluye `iss` en las
respuestas de autorización, tanto exitosas como de error, para habilitar ese
callback estable. Véase la [documentación oficial de OpenAI](https://developers.openai.com/plugins/build/auth#redirect-url).

Si una conexión existente todavía muestra un callback particular, podés crear
una conexión nueva o conservarla configurando su dirección exacta:

```sh
OAUTH_CLIENT_ID=chatgpt OAUTH_REDIRECT_URI='https://chatgpt.com/connector/oauth/TU_CALLBACK' pnpm tunnel
```

En ChatGPT ingresá `chatgpt` como ID de cliente. El proxy usa PKCE sin secreto de
cliente; la contraseña impresa se escribe en la página de login del proxy.
Solo se admite el callback exacto configurado, asociado a ese ID. `OAUTH_REDIRECT_URI`
permite reemplazar el valor por defecto para otra conexión o cliente.

Referencia: [Tunnelmole](https://github.com/robbie-cahill/tunnelmole-client).

## Variables

| Var | Defecto | Notas |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Interfaz del proxy (puede ser `0.0.0.0`; el `iss` se normaliza a `127.0.0.1`). |
| `PROXY_PORT` | `9910` | Puerto del proxy. |
| `PROXY_PUBLIC_URL` | `http://HOST:PORT` | Override del `iss` y base de discovery. |
| `UPSTREAM_URL` | `http://127.0.0.1:9908` | **Debe ser loopback** o el proceso termina. |
| `OAUTH_PASSWORD_HASH` | obligatorio | Hash scrypt generado con `pnpm password:hash`. Sin hash válido el proxy no arranca. |
| `OAUTH_REDIRECT_URI` | `https://chatgpt.com/connector_platform_oauth_redirect` | URL HTTPS exacta de retorno del cliente remoto. |
| `OAUTH_CLIENT_ID` | `chatgpt` | ID asociado al callback externo; `local-browser` está reservado. |
| `OAUTH_AUDIENCE` | `llamaharness-local` | `aud` esperado en los JWT. |
| `ACCESS_TTL_SEC` | `300` | Vida del access token. |
| `SESSION_TTL_SEC` | `43200` | Vida de la cookie `lh_session`. |
| `SESSION_SECRET` | sin efecto en la sesión | Las sesiones son opacas y se guardan en memoria; fijarlo no las conserva al reiniciar. |
| `KEYS_DIR` | `./.keys` | Llave `RS256` persistida (`private.pem`, `0600`, gitignore). O `DEV_PRIVATE_KEY_PEM` con el PEM. |

## Endpoints

Discovery y emisión: `GET /healthz`, `/.well-known/openid-configuration`,
`/.well-known/oauth-protected-resource`, `/jwks.json`, `GET /authorize`,
`POST /oauth/signin`, `POST /token`, `GET /oauth/login`.

`POST /authorize/approve` y `GET /oauth/callback` requieren una sesión autenticada.
La aprobación exige además un token CSRF. `/userinfo` requiere Bearer o sesión.
`GET /oauth/logout` muestra una confirmación; `POST /oauth/logout` exige sesión y CSRF.

Protegidos (deny-by-default, `Bearer` local o cookie): `/mcp` (todos los métodos),
`/sse`, `/messages*`. Sin credencial válida → `401` con `WWW-Authenticate`
apuntando al resource metadata (spec MCP). Al reenviar se stripean
`authorization`, `x-api-key`, `cookie` y `?apiKey=`/`?api_key=`.

## Flujos

**Cliente MCP (Authorization Code + PKCE):**
`401` → lee `resource_metadata` → discovery → `GET /authorize?...&code_challenge=S256`
→ contraseña → sesión → botón *Autorizar acceso* → `code` → `POST /token` (con `code_verifier`) →
`Bearer` en cada `POST /mcp`. `redirect_uri` permitidas: mismo origen del proxy
o `http://127.0.0.1|localhost|::1:*` (clientes nativos). El cliente remoto configurado
solo puede usar su `OAUTH_REDIRECT_URI` exacta.

**Navegador (para `EventSource`, que no manda headers):**
`GET /oauth/login` → contraseña → autoriza → `/oauth/callback` rota cookie `lh_session`
(`HttpOnly`, `SameSite=Lax`) → `GET /sse` con cookie abre el stream.

## Acceso con contraseña

La contraseña identifica a un único usuario (`local-user`), sin proveedor externo.
El proxy solo almacena su hash scrypt con sal aleatoria. La sesión usa una cookie
`HttpOnly`, `SameSite=Lax` y `Secure` cuando la URL pública es HTTPS. Los formularios
protegen el login, la aprobación y el logout con tokens CSRF. Iniciar sesión ya
habilita el acceso por cookie al MCP; el consentimiento permite emitir un código para el cliente.

Cada formulario de login dura cinco minutos y se puede usar una sola vez. Abrir
otro formulario no invalida los anteriores. Si reiniciás el proxy, iniciá de nuevo
la conexión desde ChatGPT; los formularios anteriores pierden su contexto.

Se admiten cinco intentos de contraseña por dirección de conexión en quince minutos.
Una contraseña válida reinicia ese contador; tras alcanzar el límite hay que esperar.
El proxy no confía en `X-Forwarded-For`: detrás de un túnel o reverse proxy, varios
usuarios pueden compartir el mismo contador. El límite y las sesiones están en memoria.

HTTP solo se permite si tanto la URL anunciada como la interfaz de escucha son loopback.
Para acceso remoto, configurá `PROXY_PUBLIC_URL=https://tu-dominio` y terminá TLS en
el túnel o reverse proxy. Esta variable no publica el servidor por sí sola.

La conexión real con ChatGPT todavía debe verificarse. Quedan pendientes la
validación de `resource` y los permisos por scope.
Ver [el ejemplo de ChatGPT](docs/ejemplo-chatgpt.md).

## Test

```sh
pnpm typecheck && pnpm build && pnpm test
# test/e2e-local.mjs levanta backend+proxy en puertos efímeros con KEYS_DIR temporal:
# fase 1 con backend --transport http, fase 2 con --transport sse
# (E2E_UPSTREAM_PORT / E2E_PROXY_PORT fijan puertos si se necesita)
```
