# Importar skills, agentes y hooks de Claude Code

La extensión `claude-compat` (`extensions/claude-compat.ts`, módulos en `lib/claude-compat/`) importa de forma **explícita** lo que tenés en Claude Code y lo adapta a Pi sin ampliar permisos. No busca paridad completa: lo que no se puede representar con seguridad se reporta y queda bloqueado.

## Uso

```text
/claude-compat:sync     importa, informa y recarga Pi
/claude-compat:status   muestra la última importación
```

Nada se importa solo: al arrancar, la extensión únicamente lee el estado derivado de la última sincronización. Para revertir, borrar `<agentHome>/claude-import/` y los agentes `<agentHome>/agents/claude-*.md` (ver [Recuperación](#recuperación)).

## Qué lee y qué escribe

Lee (nunca modifica):

- `~/.claude/settings.json` (`enabledPlugins`, `skillOverrides`, `hooks`) y `~/.claude/plugins/installed_plugins.json`.
- De cada plugin **habilitado e instalado con scope `user`**: `skills/`, `agents/`, `hooks/hooks.json` y las rutas declaradas en `.claude-plugin/plugin.json`. Las instalaciones con scope de proyecto o local de otros repos no se promueven a configuración global.
- `~/.claude/skills/` y `~/.claude/agents/`.

Escribe, solo bajo el home de agente que resuelve `bin/gentle-shell.mjs` (`GENTLE_PI_AGENT_HOME`/`PI_CODING_AGENT_DIR`):

- `claude-import/state.json`: estado derivado, regenerable y **local**; no publicarlo.
- `claude-import/skills/<nombre>/`: copias adaptadas de skills con nombres no portables.
- `agents/claude-<plugin>-<agente>.md`: agentes convertidos.

No toca `settings.json` de Pi ni de Claude Code. Un archivo derivado que editaste a mano no se sobrescribe ni se borra: se informa en "Archivos derivados conservados".

## Skills

- Una skill por nombre, elegida **antes** de que Pi cargue nada, y entregada por el evento nativo `resources_discover`.
- Precedencia determinista: skills nativas de Pi (agent home, `~/.agents/skills`, el paquete y las del proyecto) > plugins habilitados ordenados por clave, instalación más nueva primero > `~/.claude/skills`. Las versiones anteriores de un plugin solo aportan skills que la más nueva no tiene.
- Duplicados y skills de otros hosts que no ganaron se informan y no se cargan, así el catálogo importado no agrega avisos de colisión.
- Nombres no portables (`sample:report`, mayúsculas, espacios) se normalizan (`sample-report`) en una copia en caché que incluye `references/`, `scripts/` y `assets/`; el original queda intacto y la copia apunta a su directorio.

### Desactivar skills con `skillOverrides`

Una entrada de `skillOverrides` en `~/.claude/settings.json` con valor exacto `"off"` deja esa skill fuera de la importación:

```json
{ "skillOverrides": { "sample:report": "off" } }
```

- La clave puede ser el nombre declarado, su forma portable normalizada o, en skills de plugins, el nombre con el prefijo del plugin que muestra Claude Code: una skill `report` del plugin `sample` se desactiva con `sample:report` o `sample-report` (el prefijo no se duplica si el nombre ya lo trae). Las skills de `~/.claude/skills` no llevan prefijo.
- El filtro se aplica a cada candidata **antes** de elegir ganadores o escribir copias: ninguna versión anterior del plugin, duplicado de otro plugin ni copia en `~/.claude/skills` la reintroduce. Las demás skills del plugin siguen disponibles; el plugin no se deshabilita.
- Cualquier otro valor, un objeto vacío o la ausencia del campo no cambian la selección.
- Tras marcarla y ejecutar `/claude-compat:sync`, la skill deja de publicarse por `resources_discover` y su copia derivada intacta se retira (una editada a mano se conserva, como siempre). Quitar la entrada y sincronizar de nuevo la restaura sin reinstalar el plugin.
- El informe la lista en "Skills desactivadas por skillOverrides".
- Es una decisión del importador: no reescribe la configuración de Claude Code ni de Pi, no reemplaza los permisos de Claude Code y no desactiva skills que Pi descubre por su cuenta (agent home, `~/.agents/skills`, el paquete o el proyecto).

## Agentes

- La lista `tools:` se traduce a una allowlist exacta de Pi: `Read/Write/Edit/MultiEdit/Grep/Glob/LS` → `read/write/edit/grep/find/ls`, `Skill` → `read`, `ToolSearch` → `tool_search`, `AskUserQuestion` → `ask_user_question`, `mcp__server__tool` → mismo nombre con el server normalizado, `mcp__server` → todo ese namespace.
- Herramientas sin equivalente (por ejemplo `Task`, `WebFetch`, `NotebookEdit`) se reportan y **no** se sustituyen por otras más potentes.
- Un agente sin `tools:` (en Claude Code hereda todo) no se importa: requiere adaptación manual.
- `permissionMode` nunca se importa (tampoco `bypassPermissions`). `model: inherit` usa el modelo del parent; otros modelos se resuelven con el resolver nativo y, si no hay proveedor, el child falla en vez de cambiar de modelo.
- Cada agente lleva un marcador oculto `claude_policy_*` en su `--tools`. En el child, el guard de `tool_call` aplica la política en llamadas directas, anidadas (codemode/`executeTool`), MCP y delegación.

### `Bash(pattern)`

`Bash(git status)`, `Bash(git diff *)` y `Bash(npm run test:*)` usan el `bash` nativo de Pi (con sus controles y consentimientos), después de validar que la orden sea **un único argv** sin comillas, operadores, redirecciones ni expansiones, y que coincida con el patrón. Patrones que no se pueden representar así (`Bash(git log | head)`) se reportan y no conceden shell. `Bash` sin patrón conserva el shell irrestricto de la definición original: el guard no es un sandbox del sistema operativo.

### Scripts del plugin en `Bash(pattern)`

En agentes de plugins, una palabra `${CLAUDE_PLUGIN_ROOT}/…` (o `$CLAUDE_PLUGIN_ROOT/…`) se resuelve al sincronizar a la ruta absoluta del script, con barras `/`, la misma que el agente ve en sus instrucciones:

```text
tools: Read, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/deploy.sh *)
→ el child puede ejecutar  <raíz-del-plugin>/scripts/deploy.sh staging --dry-run
```

- El script debe existir, ser un archivo regular y quedar **dentro de la raíz del plugin** después de seguir symlinks y junctions; `..`, rutas que salen de la raíz o scripts ausentes dejan el patrón como capacidad no soportada.
- La contención se vuelve a comprobar en **cada** llamada: si después de importar el script o su directorio pasan a apuntar fuera del plugin, o el script desaparece, la llamada se bloquea hasta restaurarlo y sincronizar.
- Los argumentos siguen la gramática restringida: comillas, espacios dentro de un argumento, `;`, `$(…)` o redirecciones se **rechazan**, nunca se reinterpretan ni se reescriben. Otra forma de escribir la ruta (`scripts/../scripts/deploy.sh`) no es el script concedido.
- Una raíz de plugin con caracteres fuera de esa gramática (por ejemplo espacios en la ruta del home) no se puede conceder así y se reporta.
- Solo resuelve la ruta: no amplía la allowlist, no omite el consentimiento de `bash` y no habilita `updatedInput`. Los agentes de `~/.claude/agents` no tienen raíz de plugin, así que el placeholder sigue sin soporte allí.

### Fallo cerrado

El guard se registra antes de leer el estado. Si `state.json` es ilegible o la política no existe, el child de un agente importado se bloquea. Si un child carga solo el fallback curado de extensiones (sin `claude-compat`), `child-safety` bloquea a los agentes importados.
Con `state.json` ilegible, cada guard `PreToolUse` de `claude-compat.json` bloquea las llamadas que cubre (y si `claude-compat.json` también es ilegible se bloquea toda herramienta) hasta reparar y ejecutar `/claude-compat:sync`.

## Hooks

Ningún hook de Claude Code se ejecuta salvo que lo declares como revisado en `claude-compat.json` dentro del config home de Gentle AI:

```json
{
  "schema": "gentle-pi.claude-compat/v1",
  "hooks": [
    { "id": "pre-push-guard", "plugin": "mi-plugin", "script": "hooks/pre-push.sh", "event": "PreToolUse", "tools": ["Bash"] },
    { "id": "session-context", "plugin": "mi-plugin", "script": "hooks/context.mjs", "event": "SessionStart" }
  ],
  "nativeEquivalents": { "mi-memoria": "Gentle AI ya la provee" }
}
```

Contrato de cada evento traducido:

| Evento | Payload (stdin) | Efecto |
|---|---|---|
| `PreToolUse` | `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_use_id` | `deny`, `decision: block`, `continue: false` → bloquea. `ask` → confirmación humana nueva en cada llamada; sin UI o en un child → bloquea. `allow` → solo "sin objeciones": el consentimiento de Gentle Shell sigue aplicando. `updatedInput` no se acepta. |
| `SessionStart` | igual, más `source` (`startup`, `clear`, `resume`, `compact`…) | `additionalContext` se inyecta como contexto oculto en el siguiente turno. |
| `PostToolUse` | igual, más `tool_response` (texto) | `additionalContext` se agrega al resultado de la herramienta. |

`tool_name` y `tool_input` usan los nombres de campo de Claude Code, no los de Pi: `read`/`write` → `Read`/`Write` con `file_path` absoluto (resuelto contra `cwd`), `edit` → `Edit` (`old_string`, `new_string`) con una edición o `MultiEdit` (`edits: [{ old_string, new_string }]`) con varias, `bash` → `Bash` (`command`, `timeout` en ms), `grep` → `Grep`, `find` → `Glob`, `ls` → `LS`. Un matcher `Edit` también cubre `MultiEdit` y viceversa. Si la entrada de una herramienta conocida no tiene la forma esperada, `PreToolUse` **bloquea** la llamada y los hooks `PostToolUse` se omiten con un aviso.

Los scripts `.js/.mjs/.cjs` corren con el Node en uso y el resto con `bash` (en Windows, Git Bash; nunca el `bash.exe` de WSL en System32), sin shell intermedio, con `CLAUDE_PLUGIN_ROOT` y `CLAUDE_PROJECT_DIR`, límite de 10 s y 512 KiB de salida. En `PreToolUse`, código distinto de cero, JSON inválido, decisión desconocida, timeout o cancelación **bloquean**. En hooks de contexto, el error se avisa y no se inyecta nada.

Si un `PreToolUse` revisado no se puede resolver al sincronizar (plugin ausente o deshabilitado, script borrado o renombrado, ruta fuera del plugin), queda como guard **no disponible**: se reporta y **bloquea** toda llamada que cubra su matcher hasta restaurar el script o quitarlo de `claude-compat.json`. Los hooks de contexto no resueltos solo se reportan.

El informe separa:

- **Hooks adaptados**: los revisados.
- **Equivalentes nativos**: plugins (por defecto `engram`, porque Gentle AI integra Engram) y eventos (`Notification`, `PreCompact`) que Gentle Shell ya cubre; no se importan para no duplicar memoria, efectos ni telemetría.
- **Capacidades pendientes**: todo lo demás, incluidos los hooks de `settings.json` (comandos arbitrarios). No se ejecutan.

Para reactivar un equivalente nativo por defecto, poner su motivo vacío: `"nativeEquivalents": { "engram": "" }`.

## Integraciones opcionales

Contexto declarativo de sesión, señales de sesión y protección de escrituras de memoria **no** son parte del puente: viven en extensiones propias, cada una con su archivo de configuración y sin efecto si ese archivo no existe. Ver [Integraciones opcionales](optional-integrations.md).

## Límites

- No se importan marketplaces como paquetes Pi, telemetría de otros hosts ni modos que omiten permisos; el transcript de Pi nunca se presenta como transcript de Claude Code.
- Herramientas de orquestación propias de Claude Code sin equivalente directo quedan como limitación explícita.
- Validado con Pi 1.5.2 en Windows (tests con cargador, sesión y procesos reales, sin llamadas a modelos). macOS y Linux: pendientes de validar con esta integración; la terminación de descendientes usa grupos de procesos en POSIX y `taskkill /T` en Windows.

## Recuperación

1. Borrar `<agentHome>/claude-import/` y `<agentHome>/agents/claude-*.md` (o deshabilitar los plugins en Claude Code y volver a ejecutar `/claude-compat:sync`, que retira los derivados intactos).
2. `/reload`.

La configuración de Claude Code nunca se modifica, así que no hay nada que restaurar allí.
