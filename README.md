# Examnio

> **Integridad académica en el examen digital**

Examnio es una plataforma web de evaluación académica en línea diseñada para aplicar exámenes con monitoreo de integridad en tiempo real. Permite al profesor crear, aplicar, monitorear y calificar exámenes desde un panel centralizado, mientras los estudiantes presentan sus pruebas con detección automática de comportamientos atípicos.

**Versión:** Preliminar (v0.1) — Aplicación funcional en uso activo, en evolución continua.

---

## ¿Por qué Examnio?

El nombre proviene del latín **_examinare_** — pesar, medir, calibrar con precisión. Los romanos usaban esta misma raíz para describir el acto de calibrar una balanza. Examnio es eso: la plataforma que mide con precisión el conocimiento, con integridad.

Examnio nació de una necesidad real: poder aplicar exámenes en línea en contextos universitarios donde el uso de IA y la deshonestidad académica son una preocupación creciente. Es una idea propia, desarrollada para facilitar exámenes en tiempo real con trazabilidad completa de las acciones del estudiante.

---

## Arquitectura y Tech Stack

```
┌─────────────────────┐         ┌──────────────────────┐
│   examen.html       │         │   profesor.html       │
│   (estudiante)      │         │   (profesor/admin)    │
└────────┬────────────┘         └──────────┬───────────┘
         │                                 │
         └──────────────┬──────────────────┘
                        │
               ┌────────▼────────┐
               │  Firebase       │
               │  Firestore      │  ← tiempo real (onSnapshot)
               │  Auth           │  ← profesor autenticado
               └─────────────────┘
                        │
               ┌────────▼────────┐
               │  GitHub Pages   │  ← hosting estático
               └─────────────────┘
```

| Capa | Tecnología |
|---|---|
| Frontend | HTML + CSS + JavaScript vanilla (ES Modules) |
| Base de datos | Firebase Firestore (NoSQL, tiempo real) |
| Autenticación profesor | Firebase Authentication (email + contraseña) |
| Autenticación estudiante | Contraseña de sesión hasheada con SHA-256 por examen |
| Hosting | GitHub Pages (estático, sin servidor) |
| Resaltado de código | Prism.js — tema Night Owl — Java, Python, JavaScript, SQL |
| Notificaciones email | EmailJS (sin backend) |

---

## Estructura de Firestore

```
grupos/{grupoId}
  └── universidad, materia, grupo, año

examenes/{examenId}
  └── titulo, grupoId, preguntas[], activo, retroAlimentacionVisible,
      escala{notaMin,notaMax,notaApro}, tiempoMinutos

respuestas/{examenId}/estudiantes/{estudianteId}
  └── nombre, correo, codigo, passHash, tempPass
      inicio, fin, entregado, entregadoForzado
      respuestas{}, ordenPreguntas[], eventos[]
      puntajeTotal, calificacion, calificacionManual{}
      lastSeen, desconexiones[]

profesores/{uid}
  └── nombre, email, estado, admin, creadoEn, aprobadoEn

_meta/adminExiste
  └── centinela para detectar primer registro
```

---

## Funcionalidades por Rol

### Estudiante

- **Landing** con dos opciones: _Empezar examen_ (primera vez) o _Continuar / Ver resultados_ (ya inició)
- **Login nuevo:** nombre completo, correo institucional, código estudiantil, código del examen, contraseña de sesión (hasheada con SHA-256)
- **Login continuar:** solo código estudiantil, código del examen y contraseña
- Preguntas mostradas **una por una** en **orden aleatorio** — las opciones también se aleatorizan
- Respuestas guardadas en tiempo real — **no se puede retroceder**
- Modal de confirmación al intentar avanzar sin responder
- **Temporizador configurable** con auto-entrega al agotarse
- **Monitoreo de integridad** con widget persistente de alertas
- Al finalizar: muestra puntos obtenidos, puntos máximos y nota calculada con la fórmula explicada
- **Retroalimentación:** disponible automáticamente al entregar (la nota final se publica cuando el profesor lo decida)
- Botón de salir en la retroalimentación

### Profesor

#### Grupos y Exámenes
- Crear y eliminar grupos (Universidad → Materia → Grupo → Año/Semestre)
- Crear exámenes con JSON de preguntas, escala de calificación y tiempo límite
- **Editar JSON** de un examen existente desde un modal con validación
- Validación de ID único de examen por grupo y semestre
- Activar/desactivar examen con toggle (actualización instantánea)
- Activar/desactivar retroalimentación visible para estudiantes

#### Monitor en Tiempo Real
- Vista en tarjetas de todos los estudiantes activos
- Indicador online/offline (heartbeat cada 30s, timeout 60s)
- Tiempo transcurrido por intento
- Barra de progreso de preguntas respondidas
- Chips de eventos sospechosos registrados
- **Filtros:** Todos / Entregados / Pendientes / Con eventos / A→Z
- **Click en tarjeta** → navega directamente al intento del estudiante en Calificar

#### Calificar
- Lista de estudiantes en **acordeón** — recogidos por defecto, se despliegan al hacer click
- Resumen visible sin abrir: puntos automáticos, manuales, total y nota calculada
- Vista completa de enunciado, bloque de código y respuesta del estudiante vs respuesta correcta
- Input manual para preguntas abiertas y completar, con **recálculo en tiempo real**
- **Recalcular y guardar todas las notas** — aplica el JSON actual a todas las respuestas guardadas
- **Descargar Excel** (CSV UTF-8 con BOM) con nombre, correo, código, nota, puntos, eventos y tiempos
- Filtros: Todos / Entregados / Pendientes / A→Z

#### Administración
- Recuperar contraseña de estudiante (genera clave temporal de 6 caracteres, un solo uso)
- Eliminar intentos de un examen (para limpiar antes del examen real)
- Eliminar intento específico de un estudiante
- Limpiar todos los datos (con doble confirmación)

#### Gestión de Acceso
- Sistema de aprobación de profesores: primer registro → admin automático; siguientes → pendiente
- Notificación por email al admin cuando llega una solicitud (EmailJS)
- Notificación por email al profesor cuando es aprobado
- Panel de Solicitudes: aprobar, rechazar o revocar acceso
- Sección visible solo para el admin

---

## Cómo se Usa (Versión Actual)

### Configuración inicial

1. Habilitar **Email/Password** en Firebase Authentication
2. Configurar **Firestore Security Rules** (ver sección de seguridad)
3. Subir `examen.html` y `profesor.html` a GitHub Pages
4. Registrarse en `profesor.html` → primer registro → queda como admin automáticamente
5. Crear el documento `_meta/adminExiste` en Firestore manualmente

### Flujo de un examen

1. En `profesor.html`: crear grupo → crear examen con JSON → configurar escala y tiempo
2. Activar el examen con el toggle de Estado
3. Compartir con los estudiantes: URL de `examen.html` y el **código del examen**
4. Estudiantes entran, presentan el examen
5. Monitorear en tiempo real desde la sección Monitor
6. Al terminar: ir a Calificar → calificar preguntas manuales → Guardar nota
7. Activar Retroalimentación para que los estudiantes vean sus resultados

### Si se edita el JSON después de un examen

1. Editar JSON desde el botón **Editar JSON** en la lista de exámenes
2. Ir a Calificar → cargar el examen → click en **Recalcular y guardar todas las notas**
3. El sistema usa las respuestas guardadas y aplica el nuevo JSON

---

## Qué Captura y Cómo Evalúa

### Monitoreo de integridad

Los primeros **2 eventos son ignorados silenciosamente**. A partir del tercero, cada evento se registra en Firebase con tipo, número de pregunta, hora y timestamp. Un widget persistente muestra el conteo al estudiante con mensaje de advertencia.

**Eventos sospechosos detectados:**

| Evento | Descripción |
|---|---|
| Copiar (Ctrl+C) | Intento de copiar texto del examen |
| Cortar (Ctrl+X) | Intento de cortar texto |
| Pegar (Ctrl+V) | Intento de pegar contenido externo |
| Clic derecho | Acceso al menú contextual |
| Cambio de pestaña | Visibilidad de la página perdida (`visibilitychange`) |
| Pérdida de foco | Ventana minimizada o cambio de aplicación (`blur`) |
| Captura de pantalla (PrintScreen) | Tecla PrintScreen detectada |
| Imprimir (Ctrl+P) | Intento de imprimir la página |
| Abrir DevTools (F12, Ctrl+Shift+I/J/C) | Intento de abrir herramientas de desarrollo |
| Ver código fuente (Ctrl+U) | Intento de ver el HTML fuente |
| Evento de impresión (`beforeprint`) | Impresión por cualquier método |

> **Nota:** La selección de texto con el ratón NO se registra — se considera parte natural de la lectura.

### Desconexiones

Las desconexiones de red y las pérdidas de visibilidad quedan registradas en el array `desconexiones[]` del estudiante en Firestore, con hora y tipo.

### Fórmula de calificación

```
notaFinal = notaMin + (puntosObtenidos / puntosTotal) × (notaMax − notaMin)
```

Con la escala por defecto (0–50, aprobatoria 30):
```
Obtener 28 de 34.5 pts → 0 + (28/34.5) × 50 = 40.6
```

---

## Tipos de Preguntas y Formato JSON

El JSON de preguntas es un **array directo** de objetos. Ver `plantilla-preguntas.json` y `prompt-generador-preguntas.md` para detalles completos.

### Tipos disponibles

| Tipo | Auto | Descripción |
|---|---|---|
| `unica` | ✓ | Selección única — `opciones[]` + `correcta` (texto exacto) |
| `multiple` | ✓ | Varias correctas — `opciones[]` + `correctas[]` + `restar` |
| `verdaderoFalso` | ✓ | V/F — `correcta: true/false` |
| `completar` | ✗ | Rellenar `___` — `espacios[]` con respuestas en orden |
| `abierto` | ✗ | Desarrollo libre — solo enunciado |
| `emparejar` | ✓ | Relacionar — `pares[]` con `{izquierda, derecha}` |
| `ordenar` | ✓ | Ordenar ítems — `items[]` desordenado + `correctos[]` |

### Calificación de selección múltiple (estándar Moodle)

Con `"restar": true`:
- Cada opción correcta vale: `puntaje / n_correctas`
- Cada opción incorrecta marcada resta: `puntaje / n_correctas`
- Mínimo siempre 0 (nunca negativo)

**Ejemplo:** 1.5 pts, 3 opciones correctas de 5:
- Cada opción vale: `1.5 / 3 = 0.5 pts`
- Marcar las 3 correctas = **1.5** ✓
- Marcar 2 correctas + 1 incorrecta = `1.0 − 0.5 = 0.5`

### Escala de puntajes recomendada

| Puntaje | Nivel de dificultad |
|---|---|
| 1.0 | Definición directa, V/F, memorización |
| 1.5 | Comprensión conceptual, análisis básico |
| 2.0 | Análisis de código, múltiple con distractores |
| 2.5 | Predicción de salida, relaciones entre conceptos |
| 3.0 | Preguntas integradoras, abiertas, multi-concepto |

### Código y lenguajes

El campo `codigo` renderiza bloques con resaltado Night Owl. Lenguajes soportados: **Java, Python, JavaScript, SQL**. Para agregar otro lenguaje: incluir el script CDN de Prism en ambos HTML y usar el nombre en el campo `lenguaje` del JSON.

---

## Recursos

- `plantilla-preguntas.json` — plantilla técnica con todos los tipos, reglas y ejemplos
- `prompt-generador-preguntas.md` — prompt para generar preguntas en otro chat de Claude

---

## Seguridad

### Modelo actual

| Aspecto | Estado |
|---|---|
| Config Firebase | ⚠ Incrustada en el HTML (riesgo bajo con reglas correctas) |
| Acceso a Firestore | ✓ Reglas de seguridad configuradas |
| Autenticación profesor | ✓ Firebase Auth (email + contraseña) |
| Autenticación estudiante | ⚠ Por examen — código + contraseña hasheada SHA-256 |
| Datos de respuestas | ⚠ `allow read, write: if true` — cualquiera puede escribir si conoce la ruta |

### Fallas conocidas y aceptadas en esta versión

1. **Config Firebase expuesta:** las claves de Firebase están en el HTML. Mitigación: las Firestore Security Rules limitan lo que se puede leer/escribir. Un atacante podría leer exámenes activos pero no puede acceder al panel del profesor sin Firebase Auth.

2. **Respuestas abiertas en Firestore:** un estudiante técnico podría escribir directamente a su documento de respuestas saltándose el HTML. Mitigación parcial: el `passHash` valida la identidad, pero no hay verificación server-side.

3. **Autenticación de estudiante por examen:** no es una cuenta única global — el estudiante se identifica con código + contraseña por examen. Si alguien conoce el código y la contraseña de otro, puede ver o modificar su intento.

4. **Sin rate limiting:** no hay límite de intentos de login desde el cliente.

---

## Mejoras Futuras

- [ ] **Refactorización de arquitectura** — separar CSS, JS y HTML en archivos independientes para mejor mantenibilidad
- [ ] **IA para evaluar respuestas abiertas** — usar un LLM para dar orientación automática al calificar preguntas abiertas (no reemplaza al profesor, orienta)
- [ ] **Autenticación única por estudiante** — cuenta global del estudiante con Firebase Auth en lugar de autenticación por examen, para historial y seguimiento longitudinal
- [ ] **Variables de entorno** — migrar config de Firebase fuera del HTML usando GitHub Actions o Firebase Hosting para no exponer claves
- [ ] **Reglas Firestore más estrictas** — validar estructura de documentos server-side con reglas más granulares
- [ ] **Bootstrap o Tailwind** — mejorar el sistema de diseño sin afectar la lógica
- [ ] **Exportar a PDF** — generar reporte de calificaciones en PDF desde el panel
- [ ] **Descarga de intento en PDF por el estudiante** — desde el panel del profesor, activar que el estudiante pueda descargar su intento completo (preguntas, respuestas y retroalimentación) en PDF para subirlo como evidencia a plataformas oficiales de la universidad
- [ ] **Modo offline robusto** — mejorar la sincronización cuando el estudiante pierde conexión durante el examen

---

## Autor

Desarrollado por **Norbey Danilo Muñoz** como herramienta propia para facilitar exámenes universitarios en línea con integridad académica. Idea original y desarrollo propio.

---

## Licencia

Uso académico personal. Versión preliminar — no apta para producción a gran escala.

---

---

# Examnio (English Version)

> **Academic integrity in the digital exam**

Examnio is a web-based academic evaluation platform designed to administer online exams with real-time integrity monitoring. It enables professors to create, apply, monitor, and grade exams from a centralized panel, while students take their tests with automatic detection of atypical behavior.

**Version:** Preliminary (v0.1) — Functional application in active use, continuously evolving.

---

## Why Examnio?

The name comes from the Latin **_examinare_** — to weigh, measure, calibrate with precision. Romans used this same root to describe the act of calibrating a scale. Examnio is exactly that: the platform that measures knowledge with precision and integrity.

Examnio was born from a real need: applying online exams in university settings where AI use and academic dishonesty are growing concerns. It is an original idea, developed to facilitate real-time exams with complete traceability of student actions.

---

## Architecture & Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML + CSS + Vanilla JavaScript (ES Modules) |
| Database | Firebase Firestore (NoSQL, real-time) |
| Professor Auth | Firebase Authentication (email + password) |
| Student Auth | SHA-256 hashed session password per exam |
| Hosting | GitHub Pages (static, no server) |
| Syntax Highlighting | Prism.js — Night Owl theme — Java, Python, JavaScript, SQL |
| Email Notifications | EmailJS (no backend required) |

---

## Features by Role

### Student

- Landing page with two options: _Start exam_ (first time) or _Continue / View results_ (already started)
- One question at a time in **random order** — options also randomized
- Answers saved in real-time — **cannot go back**
- Configurable timer with auto-submit on expiry
- **Integrity monitoring** with persistent alert widget
- On submission: shows points obtained, total points, and calculated grade with formula
- **Retroalimentación (feedback):** available immediately after submission (final grade published when professor decides)

### Professor

- Create and manage groups (University → Subject → Group → Year/Semester)
- Create exams with JSON questions, grading scale, and time limit
- **Edit JSON** of existing exam with validation modal
- Real-time **Monitor**: online/offline status, progress bar, suspicious events, elapsed time per attempt
- **Grading**: accordion view, manual inputs for open questions, real-time recalculation
- **Recalculate all grades** with one click after editing JSON
- **Download Excel** (UTF-8 CSV) with complete results
- Professor approval system: first registration → automatic admin; subsequent → pending approval with email notification

---

## Suspicious Events Detected

| Event | Description |
|---|---|
| Copy (Ctrl+C) | Attempt to copy exam content |
| Cut (Ctrl+X) | Attempt to cut content |
| Paste (Ctrl+V) | Attempt to paste external content |
| Right click | Context menu access |
| Tab change | Page visibility lost |
| Focus loss | Window minimized or application switch |
| PrintScreen | Screenshot key detected |
| Print (Ctrl+P) | Print attempt |
| DevTools (F12, Ctrl+Shift+I/J/C) | Developer tools access attempt |
| View source (Ctrl+U) | HTML source view attempt |
| beforeprint | Print triggered by any method |

> First 2 events are silently ignored. From the 3rd onward, each event is logged to Firebase with type, question number, time, and timestamp.

---

## Question Types & JSON Format

See `plantilla-preguntas.json` and `prompt-generador-preguntas.md` for full details.

| Type | Auto-graded | Description |
|---|---|---|
| `unica` | ✓ | Single choice |
| `multiple` | ✓ | Multiple correct answers with optional penalty (`restar: true`) |
| `verdaderoFalso` | ✓ | True/False |
| `completar` | ✗ | Fill in the blanks |
| `abierto` | ✗ | Open-ended (manual grading) |
| `emparejar` | ✓ | Matching columns |
| `ordenar` | ✓ | Drag to reorder |

### Multiple choice grading (Moodle standard)

With `"restar": true`:
- Each correct option is worth: `score / n_correct`
- Each incorrect option marked deducts: `score / n_correct`
- Minimum always 0 (never negative)

---

## Known Security Limitations

1. **Firebase config exposed** in HTML — mitigated by Firestore Security Rules
2. **Student auth is per-exam** — not a global account; no server-side answer validation
3. **Responses collection is open** — a technical student could write directly to Firestore
4. **No rate limiting** on client-side login attempts

---

## Planned Improvements

- [ ] Architecture refactoring — separate CSS, JS, and HTML files
- [ ] **AI-assisted open answer grading** — use an LLM to provide orientation when grading open questions
- [ ] **Unique student authentication** — global Firebase Auth account instead of per-exam credentials
- [ ] Move Firebase config to environment variables
- [ ] Stricter Firestore Security Rules with server-side document validation
- [ ] PDF export for grade reports
- [ ] **Student attempt PDF download** — allow professors to enable students to download their full attempt (questions, answers, feedback) as PDF evidence for university platforms

---

## Author

Developed by **Norbey Danilo Muñoz** as a personal tool to facilitate real-time university exams with academic integrity monitoring. Original idea and development.
