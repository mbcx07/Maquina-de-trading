
/**
 * MODO DIAGNÓSTICO SRE v2.0
 * Ejecuta pruebas de conectividad profunda para identificar bloqueos de Binance o problemas de red.
 */
export const runDiagnostics = async () => {
  if (localStorage.getItem('DIAG') !== '1') return;

  console.log("%c--- INICIANDO MODO DIAGNÓSTICO SRE ---", "color: orange; font-weight: bold; font-size: 14px;");

  // A.0 Check for Proxy environment variables (Explicitly requested task B)
  try {
    const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
    proxyVars.forEach(v => {
      // @ts-ignore - Browser environment check
      const envVal = typeof process !== 'undefined' && process.env ? process.env[v] : null;
      if (envVal) {
        console.warn(`[DIAG] ALERTA PROXY: Se detectó ${v}=${envVal}. Esto puede causar bloqueos en Binance.`);
      }
    });
  } catch (e) {}

  // A.1 Detectar IP pública de salida
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const ipData = await ipRes.json();
    console.log(`[DIAG] IP Pública Salida: ${ipData.ip}`);
  } catch (e) {
    console.error("[DIAG] ERROR: No se pudo determinar la IP pública. Posible fallo DNS o Firewall total.");
  }

  // A.2 Prueba HTTP sin auth (REST) con logs detallados de status, headers y body
  const endpoints = [
    'https://api.binance.com/api/v3/ping',
    'https://api.binance.com/api/v3/time',
    'https://fapi.binance.com/fapi/v1/ping'
  ];

  for (const url of endpoints) {
    const start = performance.now();
    try {
      const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
      const lat = (performance.now() - start).toFixed(2);
      const text = await res.text();
      
      console.log(`[DIAG] GET ${url}`);
      console.log(`  - Status Code: ${res.status}`);
      console.log(`  - Latencia: ${lat}ms`);
      console.log(`  - Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
      console.log(`  - Body: ${text.substring(0, 100)}`);

      if (res.status === 451) {
        console.warn("[DIAG] EVIDENCIA: Bloqueo regional detectado (HTTP 451). Binance prohíbe el acceso desde tu IP actual.");
      }
    } catch (e: any) {
      // A.3 Prueba DNS + TLS (Inferencia via error de fetch)
      console.error(`[DIAG] Fallo crítico en conexión a ${url}: ${e.message}`);
      if (e.message.toLowerCase().includes('ssl') || e.message.toLowerCase().includes('tls')) {
        console.error("[DIAG] TLS HANDSHAKE FAIL: Problema detectado en la negociación de certificados.");
      } else if (e.message.toLowerCase().includes('dns') || e.message.toLowerCase().includes('fetch')) {
        console.error("[DIAG] DNS/NETWORK FAIL: Imposible alcanzar el host.");
      }
    }
  }

  // A.4 Prueba WebSocket (Stream) directo
  const wsUrl = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
  console.log(`[DIAG] Intentando conexión WS: ${wsUrl}...`);
  
  const ws = new WebSocket(wsUrl);
  let messageReceived = false;
  const wsStart = Date.now();

  ws.onopen = () => console.log(`[DIAG] WS OPEN: Conexión establecida en ${Date.now() - wsStart}ms.`);
  
  ws.onmessage = (msg) => {
    if (!messageReceived) {
      console.log("[DIAG] WS DATA: Mensaje recibido correctamente. Conexión WebSocket OK.");
      console.log(`[DIAG] Payload: ${msg.data.substring(0, 100)}...`);
      messageReceived = true;
      ws.close();
    }
  };

  ws.onerror = (e) => {
    console.error("[DIAG] WS ERROR: Error detectado en el canal WebSocket.");
  };

  ws.onclose = (e) => {
    console.log(`[DIAG] WS CLOSE: Código ${e.code}, Razón: ${e.reason || 'Desconexión normal'}`);
    if (e.code === 1006) {
      console.warn("[DIAG] ADVERTENCIA: Código 1006 detectado. Típico de bloqueos por Firewall o Proxy.");
    }
  };

  setTimeout(() => {
    if (!messageReceived && ws.readyState !== WebSocket.CLOSED) {
      console.error("[DIAG] WS TIMEOUT: No se recibieron datos en 10s. Probable 'silent drop'.");
      ws.close();
    }
  }, 10000);
};
