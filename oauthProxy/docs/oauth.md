# OAuth: conceder acceso sin entregar la contraseña

Un editor de documentos puede necesitar leer archivos de Google Drive. Entregarle la contraseña del usuario le daría un acceso demasiado amplio. OAuth 2.0 permite conceder permisos mediante una credencial específica, llamada *access token*, sin compartir esa contraseña.

El servicio que aloja los recursos conserva la responsabilidad de comprobar qué permite la credencial y durante cuánto tiempo. Para entender el mecanismo, seguiremos una autorización desde la solicitud inicial hasta la llamada a la API. En [el ejemplo de ChatGPT](ejemplo-chatgpt.md) veremos cómo se aplica al proxy de este proyecto.

## Quién participa

OAuth distingue cuatro papeles. El **propietario del recurso** concede acceso; en nuestro ejemplo, el usuario de Drive. El **cliente** es la aplicación que lo solicita, como el editor. El **servidor de autorización** emite las credenciales y el **servidor de recursos** las comprueba antes de responder a las llamadas de la API. Un mismo servicio puede asumir estos dos últimos papeles.

El cliente se identifica mediante un `client_id`, que lo relaciona con su configuración, pero no constituye una contraseña ni una prueba de identidad. Algunos clientes utilizan además un `client_secret` para autenticarse. Ese secreto solo es adecuado cuando pueden protegerlo: una aplicación distribuida al usuario no puede considerar confidencial un valor incluido en su código.

## Del permiso al token

En el flujo de código de autorización con PKCE, el cliente lleva al usuario, mediante el navegador, a la página de autorización del servicio. La solicitud identifica a la aplicación, declara los permisos que necesita y contiene una `redirect_uri`: la dirección a la que regresará el navegador. Incluye también `state` y un desafío PKCE para proteger el recorrido.

El servicio autentica al usuario cuando corresponde y resuelve la autorización. Si concede el acceso, redirige el navegador a la dirección acordada con un **código de autorización** temporal y de un solo uso. Este código todavía no permite llamar a la API.

El cliente presenta el código al servidor de autorización, junto con los datos necesarios para verificar el intercambio. Si las comprobaciones son correctas, recibe un access token. A partir de entonces puede presentarlo en sus peticiones al servidor de recursos:

```http
GET /drive/v3/files HTTP/1.1
Host: www.googleapis.com
Authorization: Bearer ACCESS_TOKEN
```

El navegador interviene en la autorización y en el regreso al cliente. El canje del código y las llamadas a la API ocurren donde se ejecuta el cliente. Si es un servicio remoto, esas peticiones salen de sus servidores, aunque el usuario haya autorizado desde su computadora.

## Permisos y credenciales

Los **scopes** nombran los permisos solicitados, como leer documentos o modificar un calendario. Cada servicio define su significado y debe comprobarlos antes de permitir una operación. Incluir un scope en un token no impone una restricción por sí solo.

El access token puede ser una cadena opaca o un documento firmado, como un JWT; OAuth no exige un formato único. Con el esquema `Bearer`, quien posee una credencial válida puede usarla, por lo que debe protegerse durante su almacenamiento y transmisión. La firma de un JWT permite comprobar su integridad y su emisor, pero no cifra su contenido.

## Cómo protegen el intercambio PKCE y state

El **verificador PKCE** (`code_verifier`) es un secreto aleatorio que el cliente genera antes de iniciar la autorización y guarda hasta canjear el código. Con el método `S256`, calcula un hash de ese secreto, llamado `code_challenge` o desafío:

```text
code_challenge = BASE64URL(SHA256(code_verifier))
```

La codificación Base64URL se utiliza sin relleno. El cliente envía el desafío al solicitar autorización. Cuando recibe el código, lo presenta junto con el secreto original. El servidor calcula el hash del secreto recibido y comprueba que coincide con el desafío inicial. Así, robar el código de autorización no alcanza para obtener un token: también hace falta conocer el verificador. El cliente gestiona este secreto automáticamente; el usuario no necesita escribirlo ni recordarlo.

El parámetro `state` relaciona la respuesta con la solicitud original. Cuando regresa el navegador, el cliente comprueba que el valor recibido coincide con el de una autorización pendiente de ese usuario. Así evita aceptar una respuesta ajena como propia.

## Renovación e identidad

El access token suele tener una vida limitada. El servidor puede entregar además un **refresh token**, con el que el cliente solicita nuevas credenciales sin repetir inmediatamente la intervención del usuario. Ese token se presenta al servidor de autorización, no a la API de recursos. Su duración, rotación y revocación dependen de la implementación.

Cerrar una sesión de navegador no garantiza que se invaliden los tokens emitidos. El sistema debe definir qué credenciales revoca y cómo hace efectiva esa decisión.

Autenticar significa comprobar quién actúa; autorizar, decidir qué puede hacer. OAuth organiza la concesión de acceso. OpenID Connect, u OIDC, añade una capa de identidad y utiliza un *ID token* para comunicar al cliente información verificable sobre la autenticación. Publicar endpoints con nombres habituales de OIDC no basta para implementar esa capa.

El `oauthProxy` implementa una identificación con contraseña propia: comprueba su hash, crea una sesión y permite aprobar el acceso del cliente. El usuario no comparte esa contraseña con ChatGPT. El [capítulo siguiente](ejemplo-chatgpt.md) explica el recorrido y qué falta para completar una integración remota.
