# Microsoft Dev Tunnels para `oauthProxy`

Esta guía publica **únicamente** `oauthProxy` (HTTP local en `127.0.0.1:9910`) mediante una URL HTTPS **persistente** para conectarlo como MCP en ChatGPT. El backend `llamaharness` sigue escuchando en `127.0.0.1:9908`, sin exposición directa a Internet.

```text
ChatGPT ── HTTPS ── Dev Tunnels ── oauthProxy :9910 ── loopback ── llamaharness :9908
                                  OAuth + contraseña                MCP
```

> Dev Tunnels es un servicio de desarrollo (preview), no una solución de alojamiento permanente con SLA. **URL persistente** significa que no cambia al parar y volver a alojar el *mismo* túnel; los procesos y la computadora deben permanecer encendidos para responder. El servicio puede eliminar túneles inactivos después de 30 días.

## 1. Instalar la CLI (Linux/Ubuntu)

```bash
curl -sL https://aka.ms/DevTunnelCliInstall | bash
devtunnel --version
devtunnel user login
```

Se requiere una cuenta de Microsoft o GitHub para administrar el túnel. Para autenticar con GitHub: `devtunnel user login -g`. Recomendación: revisá el script de instalación antes de ejecutarlo si tu política de seguridad lo requiere.

## 2. Crear una URL persistente (solo una vez)

```bash
# Crear un túnel persistente. Guardar el ID que muestra este comando:
devtunnel create

# Reemplazar TUNNEL_ID por el ID real (sin < >):
devtunnel port create TUNNEL_ID -p 9910 --protocol http

# Permitir que ChatGPT llegue al proxy sin iniciar sesión en Microsoft:
devtunnel access create TUNNEL_ID --port 9910 --anonymous

# Mostrar la configuración:
devtunnel show TUNNEL_ID
devtunnel port list TUNNEL_ID
```

También se puede elegir el identificador al crear, por ejemplo `devtunnel create llamaharness`, si está disponible. **No uses** `devtunnel host -p 9910` sin ID: puede crear un túnel temporal y cambiar la URL en cada arranque.

El acceso anónimo aplica **solo al túnel**: cualquier persona puede llegar a la URL, pero `oauthProxy` debe exigir OAuth para usar las herramientas. Nunca expongas directamente el backend `9908`.

## 3. Arrancar el backend MCP

En la terminal 1, desde el directorio `oauthProxy`:

```bash
node ../llamatools/dist/llamaharness.js --transport http --host 127.0.0.1 --port 9908
```

No configurar una API key en el backend de este esquema: `oauthProxy` realiza la autenticación. **Verificá** que el backend sea accesible exclusivamente desde loopback y que otras personas/procesos locales no puedan usarlo indebidamente.

## 4. Alojar el túnel

En la terminal 2:

```bash
devtunnel host TUNNEL_ID
```

Copiá **la URL HTTPS del puerto 9910** que aparece en pantalla. Ejemplo inventado:

```text
https://abc123-9910.usw2.devtunnels.ms/
```

Mantené esa terminal abierta.

## 5. Arrancar `oauthProxy`

En la terminal 3, desde `oauthProxy`:

```bash
pnpm install
pnpm dev:public https://abc123-9910.usw2.devtunnels.ms
```

Reemplazá el dominio de ejemplo por la URL real **sin barra final ni `/mcp`**. El script `scripts/start-proxy.mjs` compila e inicia el proxy local, configura `PROXY_PUBLIC_URL` y genera una contraseña de inicio de sesión que imprime en la terminal. No compartas esa contraseña.

El proxy escucha por defecto en `127.0.0.1:9910`. No es necesario configurar `PROXY_HOST=0.0.0.0`.

## 6. Conectar con ChatGPT

Usá la URL del MCP:

```text
https://abc123-9910.usw2.devtunnels.ms/mcp
```

En el registro de cliente OAuth, usá los valores que admite el proxy (por defecto `client_id=chatgpt` y callback `https://chatgpt.com/connector_platform_oauth_redirect`). Seguí la pantalla de autorización e ingresá la contraseña **solo en el login del proxy**. La conexión remota real debe probarse: las pruebas E2E locales no sustituyen la prueba desde ChatGPT.

Para una comprobación básica:

```bash
curl -i https://abc123-9910.usw2.devtunnels.ms/healthz
curl -i https://abc123-9910.usw2.devtunnels.ms/mcp
```

La segunda petición, sin token, debe devolver `401 Unauthorized`. Los navegadores podrían mostrar una pantalla antiphishing inicial de Dev Tunnels; esta intermediación puede complicar clientes remotos. Si ocurre, consultá la documentación de seguridad de Dev Tunnels.

## 7. Reiniciar sin cambiar la URL

Cuando vuelvas a iniciar los servicios, **no recrees el túnel**. Ejecutá de nuevo las tres terminales de los pasos 3, 4 y 5, con el **mismo** `TUNNEL_ID` y la **misma** URL. Los comandos útiles son:

```bash
devtunnel list
devtunnel show TUNNEL_ID
devtunnel port list TUNNEL_ID
devtunnel host TUNNEL_ID
# Eliminación definitiva (pierde la URL):
# devtunnel delete TUNNEL_ID
```

Si se elimina por inactividad, por expiración o por administración del servicio, habrá que crear otro y actualizar la URL del MCP. Que la URL sea fija no significa que la conexión esté disponible cuando el equipo esté apagado.

## Seguridad

- La opción `--anonymous` deja públicamente accesible el **proxy**, no lo autentica; OAuth es la barrera efectiva. Usá contraseñas fuertes.
- Mantené `9908` solo en loopback. No expongas `/mcp` del backend sin autenticación: algunas herramientas incluyen acceso a archivos y Bash.
- Protegé la clave privada RSA `.keys/private.pem` y los tokens persistidos. Si el volumen no respeta permisos Unix (por ejemplo, ciertos montajes `fuseblk`), guardalos en un directorio protegido con permisos efectivos.
- Antes de usarlo como servicio público, completá las comprobaciones de scopes y del parámetro OAuth `resource`, además de la revocación de sesiones/tokens.

## Fuentes oficiales

- [Instalación y primeros pasos](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
- [Referencia de comandos de la CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)
- [Seguridad y pantalla antiphishing](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security)
- [Preguntas frecuentes (URL persistente)](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq)
