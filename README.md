# Harness
Exponer herramientas para un llm como grok o chatgpt.  
Se usa devtunnels de microsoft para obtener un dominio publico

## Llamaharness
Expone las herramientas en para el llm. Para seleccionar una carpeta, ir a la carpeta y correr `llamaharness --host 127.0.0.1`

## OauthProxy
Expone el metodo de autorizacion

## Connector
Genera el tunel y expone oauthproxy 

## Install
```
# install llamaharness
cd llamatools
pnpm i
pnpm build
pnpm link ./llamaharness

# install connector
cd connector
pnpm i
pnpm build
pnpm start
```

### En chatgpt

![alt text](./docs/image.png)

Agregar conector

![alt text](./docs/image-1.png)

Agregar servidor mcp

![alt text](./docs/image-2.png)

poner dominio y id de cliente:

* `chatgpt`: Para chat
* `grok`: Para grok

![alt text](./docs/image-3.png)

Ingrasar la contraseña. En la app(connector) indica la misma:  
Ej:  
**Contraseña de login**: F3dfwwef32423gwsEDESG2tSDAwr23fsdf

### Carpeta a elegir

Ir a una carpeta y correr
```
llamaharness --host 127.0.0.1
```

Esta carpeta es donde trabajara el agente



