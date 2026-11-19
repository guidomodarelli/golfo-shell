# Integraciones opcionales

Tres extensiones independientes (golfo-shell#7) que se activan solo con su propio archivo en el config home de Gentle AI (`GENTLE_PI_CONFIG_HOME`; por defecto el que resuelve `lib/agent-home.ts`). Sin ese archivo no hacen nada, no avisan y no cambian el comportamiento del importador de Claude Code ([`claude-code-compat.md`](claude-code-compat.md)).

| Integración | Extensión | Archivo | Comando |
|---|---|---|---|
| Contexto declarativo de sesión | `extensions/session-context.ts` | `session-context.json` | `/session-context` |
| Señales de sesión | `extensions/session-signals.ts` | `session-signals.json` | — |
| Protección de escrituras de memoria | `extensions/memory-write-guard.ts` | `memory-write-guard.json` | `/memory-write-guard` |

Reglas comunes:

- Cada una se activa, configura y desactiva por separado: configurar una no activa las otras, y una configuración rota solo afecta a su integración (se avisa con la ruta del archivo).
- El puente `claude-compat` no importa ninguna de ellas ni conoce sus nombres. Todas consumen eventos nativos de Pi (`session_start`, `session_compact`, `before_agent_start`, `agent_start`, `agent_end`, `session_shutdown`, `tool_call`); no hay bus de eventos propio.
- Las rutas de configuración aceptan absolutas, `~/…` o relativas al config home. No hay rutas personales fijas.
- Los ejemplos de Caveman, Mission Control y Engram son ilustrativos: ninguno es requisito del producto.

## Contexto declarativo de sesión

Texto estático que se entrega como contexto **oculto** (mensaje `session-context`, `display: false`) en el siguiente turno después de iniciar la sesión o de compactar. El texto sale del archivo o de archivos que nombra: **nunca** se ejecuta nada para obtenerlo.

```json
{
  "schema": "gentle-pi.session-context/v1",
  "entries": [
    { "id": "caveman", "file": "~/contextos/caveman.md" },
    { "id": "convenciones", "text": "Citar archivos con ruta relativa al repo.", "on": ["startup", "resume"] }
  ]
}
```

| Campo | Significado |
|---|---|
| `enabled` | `false` desactiva la integración entera (por defecto `true`). |
| `includeChildren` | `true` también lo entrega a los children de Gentle Agents (por defecto no). |
| `entries[].id` | Único; minúsculas, dígitos, `.`, `_`, `-`. |
| `entries[].text` / `entries[].file` | Exactamente uno. Máximo 16 KiB; más largo se rechaza, no se recorta. |
| `entries[].on` | Momentos: `startup`, `resume`, `clear` (`/new`), `fork`, `compact`. Por defecto todos. |
| `entries[].enabled` | `false` la deja fuera sin borrarla. |

Ciclo de sesión:

- Un **ciclo** es lo que el modelo ve hoy: desde la primera entrada que conservó la última compactación (o todo, si no hubo). Una entrada no se entrega dos veces en el mismo ciclo, aunque Pi recargue (`/reload` se trata como `resume` y solo entrega lo que falte).
- Compactar abre un ciclo nuevo: se vuelven a entregar las entradas con `compact` en `on`.
- `/session-context off [id]` la desactiva en **esta sesión** (todas sin `id`). Queda registrado en la sesión, así que no reaparece tras compactar ni recargar hasta `/session-context on [id]`. Si ya se entregó en el ciclo actual, no se retira del contexto existente; solo deja de entregarse.
- `/session-context` sin argumentos muestra el estado.

Ejemplo (Caveman): guardar las instrucciones del modo en un `.md` y declararlo como `file`. Para quitarlo en una sesión puntual, `/session-context off caveman`.

## Señales de sesión

Avisa a un consumidor externo (por ejemplo, un panel tipo Mission Control) cuando empieza un turno y cuando el agente queda inactivo.

```json
{
  "schema": "gentle-pi.session-signals/v1",
  "events": ["turn_start", "activity_end"],
  "timeoutMs": 2000,
  "target": { "type": "http", "url": "http://127.0.0.1:4545/signal" }
}
```

```json
{
  "schema": "gentle-pi.session-signals/v1",
  "target": { "type": "command", "command": "~/bin/panel-signal", "args": ["--source", "gentle-shell"] }
}
```

| Evento | Evento de Pi | Cuándo |
|---|---|---|
| `turn_start` | `agent_start` | Empieza una corrida por un prompt. |
| `activity_end` | `agent_end` | La corrida terminó (completa, abortada o con error). |

Payload, el único dato que recibe el destino (body del `POST` o stdin del comando):

```json
{ "schema": "gentle-pi.session-signal/v1", "event": "turn_start", "sessionId": "<id de sesión de Pi>", "timestamp": "2026-11-18T12:00:00.000Z" }
```

- Nunca se envían transcript, prompt, datos de herramientas, credenciales ni configuración, y nada se presenta como si viniera de Claude Code.
- `command`: ruta absoluta, `~/…`, relativa al config home o un nombre buscado solo en entradas **absolutas** del `PATH`. Se ejecuta sin shell; `args` se pasan literales. El proceso recibe un entorno mínimo (`PATH`, `HOME`/`USERPROFILE`, temporales, `LANG`), no las variables de la sesión. En Windows usar un `.exe` (o `node` con el script en `args`): `.cmd`/`.bat` necesitan shell y no se lanzan.
- `http`: solo `http:`/`https:`, sin credenciales en la URL y sin seguir redirecciones; cualquier estado distinto de 2xx es un fallo.
- Las señales de una sesión salen en orden, una a la vez. `timeoutMs` (1–10000, por defecto 2000) limita cada envío; cerrar, recargar o cambiar de sesión cancela el envío en curso sin reportarlo como fallo.
- Política de fallos: un destino caído, lento o que responde error se avisa **una vez por causa** con el destino y el evento, y la sesión sigue. Nunca bloquea un turno ni otra integración.
- Por defecto no se envían desde children (`includeChildren: true` lo habilita). `enabled: false` la apaga.

## Protección de escrituras de memoria

Mientras está activa, rechaza las escrituras configuradas de **otros** proveedores de memoria (por ejemplo, el MCP de Engram de Claude Code) para que la memoria se escriba por el proveedor nativo. La asociación sesión/proyecto y las reglas de escritura siguen siendo de la integración nativa (`gentle-engram`); esta extensión no las duplica.

```json
{
  "schema": "gentle-pi.memory-write-guard/v1",
  "protectedTools": ["mcp__plugin_engram_engram__mem_save", "mcp__plugin_engram_engram__mem_update", "mcp__plugin_engram_engram__mem_session_summary"],
  "nativeAlternative": { "tools": ["mem_save", "mem_update", "mem_session_summary"], "source": "npm:gentle-engram" }
}
```

| Campo | Significado |
|---|---|
| `protectedTools` | Nombres exactos de las escrituras a rechazar, como Pi o como Claude Code (`mcp__dev-docs__x` cubre la herramienta que Pi normaliza a `mcp__dev_docs__x`). Sin comodines: así nunca se bloquean lecturas por accidente. |
| `nativeAlternative.tools` | Herramientas del proveedor nativo; cada una debe estar cargada **una sola vez**. No pueden estar en `protectedTools`. |
| `nativeAlternative.source` | Opcional: paquete del que deben venir (`npm:gentle-engram` acepta `npm:gentle-engram@<versión>`). |
| `enabled` | `false` la desactiva. |

Política de fallos:

- **Activación** (en cada inicio o recarga de sesión): si falta alguna herramienta nativa, está duplicada o viene de otro paquete, la activación se **rechaza** con un error y no se bloquea nada: sin una ruta nativa válida no se corta la escritura de memoria.
- **Activa y luego falla la dependencia**: si en una llamada protegida la alternativa nativa ya no está disponible, la escritura se **bloquea** con un diagnóstico que dice cómo restaurarla o desactivar la protección. Nunca se reabre en silencio.
- Un archivo inválido se avisa como error y la protección queda inactiva (`/memory-write-guard` muestra el estado: inactiva, rechazada o activa).
- Alcance: llamadas directas y anidadas que pasan por el evento `tool_call` de Pi (incluidas codemode y herramientas diferidas), en la sesión principal y en children. No cubre comandos de shell que escriban memoria por otra vía (por ejemplo una CLI) ni toca lecturas, herramientas nativas o proveedores no listados.

## Compatibilidad verificada

Validado con Pi 1.5.2 y Node 24 en Windows con sesiones, cargador y herramientas reales de Pi (proveedor de modelo offline, sin llamadas a modelos), destinos HTTP y de comando reales y junctions para el escape de scripts. macOS y Linux: pendientes de validar con estas integraciones.
