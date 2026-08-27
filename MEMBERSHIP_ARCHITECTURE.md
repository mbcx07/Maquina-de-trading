# Quantum Dual V34 — Arquitectura para membresías

## Objetivo

Convertir la instalación individual actual en una plataforma SaaS donde cada usuario tenga:

- su propia cuenta y plan;
- su propia configuración de riesgo;
- sus propias credenciales Binance;
- su propio bot/chat de Telegram;
- su propia conexión MT5;
- su propio historial, posiciones, métricas y scanner lógico;
- aislamiento total de datos entre usuarios.

## Lo que ya está preparado

### Bóveda de integraciones por workspace

La tabla `integration_credentials` usa llave primaria compuesta:

`workspace_id + provider`

Los secretos se guardan cifrados con AES-256-GCM y nunca regresan al navegador después de almacenarse.

Actualmente el runtime usa `DEFAULT_WORKSPACE_ID=default`. La resolución del workspace ocurre en servidor. El cliente no puede seleccionar arbitrariamente otro workspace.

### Proveedores actuales

- `BINANCE`
- `TELEGRAM`

Posteriormente se puede agregar:

- `MT5`
- correo
- webhooks
- otros exchanges

## Regla crítica para producción SaaS

Nunca confiar en un `workspace_id`, `user_id` o `tenant_id` enviado libremente por el navegador.

Flujo correcto:

1. usuario inicia sesión;
2. middleware valida sesión/JWT;
3. backend obtiene `userId` y `workspaceId` desde la sesión firmada;
4. repositories reciben ese workspace;
5. todas las consultas SQL filtran por ese workspace;
6. clientes Binance/Telegram/MT5 se crean usando únicamente las credenciales cifradas de ese workspace.

## Migración de datos necesaria antes de abrir membresías

Las tablas de trading actuales todavía son de una sola instalación lógica. Antes de aceptar varios usuarios reales deben incorporar `workspace_id`:

- settings
- signals
- opportunities
- trades
- trade_events
- equity_snapshots
- telegram_events
- engine_state

Los índices únicos también deben ser tenant-aware.

Ejemplo Binance:

`UNIQUE(workspace_id, symbol)` para posiciones activas.

Esto permite que:

- Usuario A opere BTCUSDT.
- Usuario B también opere BTCUSDT.
- Usuario A no pueda tener dos BTCUSDT simultáneos dentro de su propio workspace.

## Runtime de trading multiusuario

No conviene crear un proceso Node completo por cada usuario. Se recomienda un `WorkspaceRuntimeManager` con estados lógicos por workspace.

Cada runtime lógico contiene:

- settings;
- vault credential provider;
- Binance execution client;
- Telegram client;
- MT5 connection;
- active slots;
- risk guard;
- reconciliation state;
- scanner subscriptions.

El market data de Binance debe compartirse globalmente para evitar consultar las mismas velas cientos de veces.

Arquitectura recomendada:

`Shared Market Data -> Shared Signal Engine -> Per-user Eligibility/Risk -> Per-user Execution`

Así 500 miembros no provocan 500 escaneos idénticos de Binance.

## Separar señal de ejecución por usuario

El scanner global calcula oportunidades una vez.

Después cada workspace decide si ejecuta según:

- plan contratado;
- Crypto habilitado;
- porcentaje por trade;
- leverage solicitado;
- slots disponibles;
- balance disponible;
- riesgo/drawdown;
- filtros del usuario;
- coin ya activa o no;
- credenciales válidas.

Forex puede requerir scanners separados cuando los brokers tengan símbolos/precios diferentes.

## Autenticación y membresía

Componentes futuros:

### users

- id
- email
- password hash / auth provider id
- status
- created_at

### workspaces

- id
- owner_user_id
- plan_id
- status
- billing_customer_id
- created_at

### subscriptions

- workspace_id
- provider
- external_subscription_id
- plan
- status
- current_period_end

### audit_log

Registrar:

- login;
- cambio de configuración;
- conexión/desconexión de Binance;
- conexión/desconexión de Telegram;
- cambio PAPER/REAL;
- start/pause engine;
- emergency stop;
- rotación de credenciales.

Nunca registrar secretos en texto claro.

## Seguridad de claves

### Desarrollo local

Si `INTEGRATION_MASTER_KEY` está vacío, V34 puede crear una llave local en:

`backend/data/.integration-vault-key`

Ese archivo está ignorado por Git.

### Producción

Usar `INTEGRATION_MASTER_KEY` desde un Secret Manager o KMS.

Requisitos:

- misma clave disponible para todas las instancias que necesiten descifrar;
- backups de base de datos y gestión de clave coordinados;
- rotación planificada;
- HTTPS obligatorio;
- nunca devolver secretos por API;
- nunca guardarlos en localStorage;
- nunca incluirlos en logs;
- rate limiting en endpoints de integración;
- reautenticación/2FA para cambiar credenciales en una plataforma comercial.

## Binance por usuario

Cada usuario introduce:

- API Key
- API Secret

La plataforma:

1. cifra ambos;
2. prueba endpoint autenticado Futures;
3. muestra únicamente valores enmascarados;
4. registra estado de última prueba;
5. usa las credenciales automáticamente en ejecución/reconciliación.

Recomendaciones mostradas al usuario:

- retirar permiso de withdrawals;
- activar únicamente permisos necesarios;
- IP whitelist si el servidor tiene IP fija;
- clave independiente para test y real.

## Telegram por usuario

Cada usuario introduce:

- Bot Token
- Chat ID o canal

La plataforma:

1. cifra ambos;
2. ejecuta `getMe`;
3. manda mensaje de prueba;
4. guarda resultado;
5. usa ese bot/chat para eventos de ese workspace.

## Planes de membresía posibles

Ejemplo futuro:

### Basic

- Signals only
- Telegram
- sin autoejecución

### Pro

- Binance auto trading
- hasta N slots
- historial completo

### Elite

- Binance + MT5
- retests Forex
- estadísticas avanzadas
- parámetros avanzados

Las restricciones de plan deben aplicarse en backend, nunca solamente ocultando botones en frontend.

## Estado actual

La bóveda de secretos e interfaz de integraciones ya están preparadas para el concepto workspace.

Antes de habilitar dos usuarios simultáneamente con dinero real todavía hace falta migrar **todos los datos y runtimes de trading** a aislamiento por workspace. Hasta entonces V34 debe considerarse una instalación individual con arquitectura preparada para esa migración.
