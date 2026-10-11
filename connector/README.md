# Connector

Esta app está escrita en TypeScript y crea un Dev Tunnel público y arranca `oauthProxy` con su dirección HTTPS. Usa los SDK oficiales de Microsoft para administrar el túnel y conectar el puerto local; no necesita VS Code ni el ejecutable `devtunnel`.

Desde esta carpeta:

```bash
pnpm install
pnpm start
```

Antes de arrancar, dejá llamaharness disponible en `127.0.0.1:9908` y detené cualquier otro proxy que esté usando el puerto `9910`. Las dependencias de `oauthProxy` deben estar instaladas: `pnpm --dir ../oauthProxy install`.

La primera ejecución muestra una dirección de GitHub y un código. Abrí esa dirección, ingresá el código y autorizá Dev Tunnels. La app guarda la autorización y el identificador del túnel en `connector/data.json`, con permisos de lectura y escritura solo para tu usuario. Guarda el access token y el refresh token, y renueva ambos automáticamente un minuto antes del vencimiento, incluso mientras el servidor sigue ejecutándose. También los reutiliza al reiniciar. Si el refresh token vence o se revoca, vuelve a pedir identificación. Las autorizaciones guardadas por versiones anteriores no contienen refresh token: al vencer el acceso necesitarás identificarte una vez para obtenerlo. También podés proporcionar un token compatible mediante `DEV_TUNNELS_GITHUB_TOKEN`; en ese caso su renovación queda a tu cargo.

Una vez conectado, la terminal muestra la contraseña del proxy, la URL MCP y los endpoints OAuth. Usá la dirección terminada en `/mcp` en ChatGPT o Grok; los clientes permitidos se configuran en `oauthProxy/config.json`. El acceso al túnel es público, mientras que el MCP sigue requiriendo la identificación de `oauthProxy`.

`Ctrl+C` cierra el proxy y la conexión al túnel. El túnel queda creado para reutilizar su dirección en el próximo arranque. La URL se conserva mientras mantengas `connector/data.json` y el túnel siga existiendo en Microsoft; puede expirar por inactividad o eliminarse desde tu cuenta. Si el túnel guardado desapareció, la app avisa antes de crear una URL distinta.

La contraseña y las sesiones OAuth siguen guardándose en `oauthProxy/data.json`. No publiques ninguno de los dos archivos `data.json`.

`connector/config.json` contiene el puerto. `package.json` declara `"oauthProxy": "link:../oauthProxy"` como dependencia local. `pnpm start` compila ambos paquetes y arranca la entrada de `oauthProxy`. El túnel solo expone ese puerto, no el backend `9908`. No ejecutes dos instancias de Connector a la vez. Si el proceso terminó con un cierre forzado y dejó `connector/.running`, eliminá ese archivo antes de reiniciar.

```bash
pnpm typecheck
pnpm test
```

Las pruebas comprueban la persistencia, el flujo de identificación, la reutilización del túnel y el arranque/cierre del proxy. Incluyen una prueba con el paquete real que verifica los endpoints y la reutilización de la contraseña tras reiniciar. La verificación real de `/healthz` público se realiza en cada arranque, después de autorizar GitHub.

Referencias: [SDK de Microsoft Dev Tunnels](https://github.com/microsoft/dev-tunnels), [autorización por código de GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
