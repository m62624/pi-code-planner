# PI Harness — Новая Архитектура (v3)

> Design document для локальной LLM. Новый harness, на котором модель программирует на новом уровне.

## 1. Git: Worktree + одна выходная ветка

### Сценарий
- План запускается → worktree создаётся автоматически
- Agent работает внутри worktree с полным набором веток
- Все внутренние ветки управляются агентом автоматически
- Завершение → одна выходная ветка в оригинальной папке
- Worktree удаляется
- User получает: main (чистый) + готовую ветку

### Plan bootstrap и cwd

Plan bootstrap должен быть атомарным:

```
planner_create_plan
  -> check git/project
  -> create storage
  -> create plan branch
  -> create worktree immediately
  -> save worktreePath into state.json
  -> move state to discovery/read_project
```

До создания plan worktree модель не должна читать проект, писать код, создавать task или запускать discovery. Ранний init существует только внутри extension bootstrap.

PI extension API не даёт прямой `ctx.setCwd()` для текущей сессии. `ctx.cwd` является текущей рабочей директорией session runtime, а built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) привязаны к этому cwd.

Рабочий способ сменить cwd из extension: переключиться на session file, чей session header содержит `cwd = worktreePath`.

```
create/open session jsonl with header cwd = <plan-worktree-path>
ctx.switchSession(sessionFile, {
  withSession: async (ctx) => {
    // replacement ctx.cwd is the worktree cwd
    // send planner resume/status instruction here
  }
})
```

Ограничения PI API:

- `ctx.newSession()` не подходит для смены cwd: он создаёт новую session в текущем runtime cwd.
- `ctx.switchSession(sessionPath)` подходит, если target session file уже содержит header с нужным cwd.
- После успешного switch старые `pi`/`ctx` stale; продолжение делается только внутри `withSession`.
- Если cwd из session header не существует, PI бросит missing cwd error.
- Если extension создаёт новый session file сам, header должен быть записан физически до `ctx.switchSession`.

Практический вывод для planner:

1. `planner_create_plan` создаёт plan branch и worktree сразу.
2. `planner_create_plan` сохраняет `worktreePath`, `currentBranch`, `lastCheckpointCommit`.
3. `planner_create_plan` переводит state сразу в `discovery/read_project`.
4. Planner создаёт или выбирает session file для worktree cwd.
5. Planner переключает PI session на этот file через `ctx.switchSession`.
6. После switch `planner_status`/resume-инструкция говорит модели начинать `discovery/read_project`.
7. Если active plan есть, но `ctx.cwd !== state.worktreePath`, normal planner flow блокируется до переключения в worktree session.

`/planner-create [--id <plan-id>] <title>` — user command, а не model tool. Он выполняет полный bootstrap и session handoff:

1. ждёт idle через `ctx.waitForIdle()`;
2. парсит title и optional explicit id;
3. если id не указан, детерминированно генерирует plan id из title через code slug, например `Fix find command` -> `fix-find-command`;
4. если auto-generated id уже существует, добавляет numeric suffix: `fix-find-command-2`, `fix-find-command-3`;
5. вызывает внутренний `planner_create_plan`;
6. резервирует путь PI session JSONL для `worktreePath`;
7. вызывает `ctx.switchSession(sessionFile, { cwdOverride: worktreePath })`;
8. через `withSession` отправляет первое сообщение в worktree session: вызвать `planner_status` и начать `discovery/read_project`.

Если user явно указал `--id`, extension только sanitizes id и не подбирает похожий автоматически. Коллизия explicit id блокируется как ошибка: user явно выбрал технический идентификатор, значит planner не должен молча создавать другой.

Сам `planner_create_plan` tool остаётся доступен как низкоуровневый wrapper, но он не может делать `switchSession`, потому что PI даёт `switchSession` только command context.

User-level plan commands:

- Planner plan list не имеет отдельной public slash command. Он используется внутри picker UX для switch/rename/delete.
- `/planner-rename [--id <plan-id>] <new-title>` — меняет только human title в `plan.json` и `project.json.plans[]`. Не меняет `planId`, директорию плана, branch names или worktree path.
- `/planner-switch <plan-id>` — переключает `project.json.activePlanId`, затем делает session handoff в `state.worktreePath` target plan. Перед switch проверяет текущий active plan: если его worktree dirty, step running, broken или requires user decision, switch блокируется.
- `/planner-delete <plan-id>` — user command only. Inactive plan удаляется только если его worktree clean или уже missing. Команда удаляет managed worktree, managed child branches, `plans/<plan-id>/`, summary из `project.json.plans[]`, worktree-index и worktree session directory. Protected plan branch не удаляется этой командой.
- `/planner-delete --force-active <plan-id>` — опасный explicit escape hatch. Нужен, если user больше не хочет продолжать текущий planner plan. Команда не ждёт recovery/clean state: сначала автоматически переключает PI session в original project cwd, затем force-removes active worktree, удаляет связанные worktree chats, planner files, worktree-index, managed child branches и сбрасывает `activePlanId`. Original session/chat не удаляется.

Эти команды не являются model tools. Они нужны user для навигации и уборки plans. Model workflow по-прежнему должен идти через planner tools и `planner_status`.

Picker UX:

1. `/planner-switch`
   - без аргументов открывает TUI select со списком планов;
   - с аргументом работает напрямую: `/planner-switch plan-a`.
2. `/planner-rename`
   - без id открывает TUI select со списком планов;
   - потом `ctx.ui.input` для нового title;
   - с аргументами работает напрямую.
3. `/planner-delete`
   - без аргументов открывает TUI select со списком планов;
   - если выбран active plan, требует отдельный confirm с timeout 10s;
   - direct CLI для active plan требует `--force-active`;
   - TUI selection для active plan показывает timed confirm;
   - inactive delete тоже требует confirm.
4. `/planner-delete --force-active <plan-id>`
   - быстрый escape hatch без лишнего ожидания, потому что user явно написал опасный флаг.

PI session JSONL хранится там же, где PI хранит обычные chats:

```
getAgentDir()/sessions/<encoded-worktree-cwd>/<timestamp>_<session-id>.jsonl
```

Физический JSONL не пишется заранее. Extension только создаёт sessions directory и выбирает будущий session path. Это важно, потому что PI сам управляет flush/persist логикой session file. Если заранее записать header-only JSONL, PI может позже дописать header повторно при первом assistant response.

Switch выполняется через runtime option `cwdOverride`, который есть в PI runtime `switchSession`, но не описан в public `ExtensionCommandContext` type. Мы используем его только в command handoff, потому что без него невозможно создать новую session в другом cwd без предварительного физического JSONL.

PI сам запишет валидный header, когда session начнёт persist. Extension не полагается на кастомные поля внутри PI session header:

```json
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"<worktreePath>"}
```

Первое user message добавляется после switch через `withSession`.

Чтобы planner tools понимали original project, когда `ctx.cwd` уже равен worktree path, extension пишет worktree index:

```
getAgentDir()/extensions/pi-code-planner/worktree-index/<hash(worktreePath)>.json
```

Index содержит:

```json
{
  "schemaVersion": 1,
  "worktreePath": "<worktreePath>",
  "projectRoot": "<originalProjectRoot>",
  "projectId": "<projectId>",
  "planId": "<planId>",
  "originalSessionFile": "<original-session.jsonl or null>"
}
```

`originalSessionFile` хранится в planner-controlled index, а не в PI JSONL header. Это нужно для финального возврата в исходную session после `done/cleanup_plan_files`. Если исходная session была ephemeral и PI вернул `undefined`, поле сохраняется как `null`; в таком случае финальный возврат делается через новое короткое сообщение в текущей worktree session или user command.

Runtime path resolution:

1. если `ctx.cwd` сам является original project и там есть `project.json`, использовать его;
2. иначе искать `worktree-index` по `ctx.cwd`;
3. если index найден, использовать `projectRoot` из него;
4. если index не найден, считать `ctx.cwd` обычным project root.

Успешное завершение плана:

1. `done/present_result` показывает итог в planner worktree session.
2. `done/await_user_acceptance` ждёт explicit accept от user.
3. После accept extension export/merge plan branch в output branch исходного repo.
4. Extension удаляет worktree и managed task/experiment/refactor branches.
5. Plan branch/output branch остаётся в обычном git repo как результат.
6. Extension переключает PI обратно в original session.
7. Original session получает короткое сообщение: plan finished, output branch, cleanup status, что user может review/merge.

Chat histories не merge-ятся. Original session хранит запрос и финальный handoff. Planner worktree session хранит рабочую историю. Источник истины — disk artifacts и git branch, а не объединённый чат.

### Почему
- User не видит agent-хаос
- User не мешает агенту
- Agent не ломает user-контекст
- Один чистый результат вместо микса веток

### Структура веток
```
plan/                    ← ветка плана (стабильная)
  task-1/                ← ветка для каждого таска
    exp-a/               ← эксперимент для task-1
    exp-b/               ← эксперимент для task-1
    exp-c/               ← эксперимент для task-1
  task-2/                ← ветка для таска 2
    exp-a/               ← эксперимент для task-2
```

### Flow
1. Эксперименты идут последовательно
2. Каждый эксперимент — альтернативный подход к одной задаче
3. Результат эксперимента → Compact → контекст для следующего
4. Agent оценивает все эксперименты
5. Лучший кандидат merge → ветка таска
6. Refactor / verify на ветке таска
7. Ветка таска merge → плановая ветка
8. Шаг за шагом, таск за таском

### Lifecycle
1. План → worktree
2. Эксперимент A → результат → Compact
3. Эксперимент B (с контекстом из Compact) → результат → Compact
4. Эксперимент C (с контекстом из Compact) → результат
5. Agent выбирает лучшего кандидата
6. Кандидат merge → task
7. Task merge → plan
8. Plan → оригинальная папка
9. Worktree → удалён
10. User: review → merge/rebase/delete

### Git как основа системы

#### Контекст через ветки
Local модель ограничена: она не понимает весь проект сразу. Она решает маленькие задачи. Наша система — это алгоритм, который дробит проект на микрозадачи и даёт модели только то, что нужно.

Каждая ветка — это изолированный контекст. Ветка task содержит только код для одной задачи. Ветка experiment — только один подход к решению. Когда модель работает в ветке, она не видит остального проекта. Это не ограничение — это преимущество. Модель фокусируется на одном.

Ветки не просто разделяют изменения — они каталогизируют контекст. Каждая ветка отвечает на вопрос: «что мы делаем прямо сейчас?».

#### Compact через ветки
Compact — это сжатие контекста через встроенный PI API. Вместо того чтобы передавать модели весь проект, мы выдаём ей файл с описанием API проекта — только то, что нужно для текущей задачи.

Когда начинается новый эксперимент, он не читает весь проект. Он получает compact-файл — сжатое описание API и контекста предыдущего шага. Это и есть сжатый контекст.

#### Эксперименты и выбор
Каждый эксперимент — это отдельная ветка с одним подходом к решению. Эксперименты идут последовательно. Результат одного → compact → контекст для следующего. Agent оценивает все эксперименты и выбирает лучший. Лучший merge → task ветка.

#### Refactor режим
После merge лучшего эксперимента в task ветку начинается refactor. Refactor — это новая ветка поверх task. Цель: улучшить код, не меняя поведение. Refactor merge → task ветка. Task merge → plan ветка.

#### Полный flow
```
plan → task → experiment-A → compact → experiment-B → compact → experiment-C
  → agent selects best → merge → task
  → refactor → merge → task
  → task → merge → plan
```

#### Compact всегда
Compact происходит между каждой мини-задачей.

Каждая ветка = одна задача = один compact. Без исключений.

#### Двухуровневая декомпозиция
Level 1: атомарные функции — одна задача, ноль побочных эффектов.
Level 2: композиция — сборка level 1 в рабочий код.

Каждый task содержит и level 1, и level 2.
Правило: level 1 пишется до level 2.
Merge task → plan = готовая задача с полным кодом.

---

## 2. Stages: Init → Discovery → Planning → Execution → Finalize → Done / Recovery

### INIT
- User пишет запрос
- Agent проверяет git repo:
  - Нет → создаёт
  - Есть → ничего не делает (git = основа системы)

### Discovery
Два пути:

**Существующий проект:**
1. Agent читает все файлы
2. Выписывает существующие паттерны в `project_patterns.md`
3. Задаёт вопросы по непонятным местам

**Проект с нуля:**
1. Agent сразу задаёт вопросы если что-то непонятно

После discovery создаётся **memory blob**:
- `project_patterns.md` — паттерны проектирования
- `symbols/` — сигнатуры функций, типов, классов
- `relations/` — как символы связаны между собой
- `files/index.jsonl` — индекс файлов

Этот blob — сжатое представление проекта. Модель не читает весь проект заново — она читает compact + memory blob.

### Planning
- На основе discovery создаёт plan
- Дробит на tasks
- Каждый task = `task.md` с инструкциями
- После `split_tasks` модель не выполняет tasks пачкой. Execution всегда берёт ровно один active task.
- Следующий task нельзя начинать, пока текущий task не прошёл merge в plan branch и `compact_task`.

### Execution
Каждый task проходит через подстадии:

1. Task branch создаётся
2. Experiments: несколько веток с разными подходами
3. Agent выбирает лучший experiment
4. Best experiment merge → task branch
5. Refactor: улучшение кода без изменения поведения
6. Task branch merge → plan branch

Каждая подстадия = compact перед следующей.

Task boundary строгий:
- task после merge в plan branch считается только compacted result;
- модель не должна переносить живой chat/context завершённого task в следующий task;
- следующий task получает только `plan.md`, свой `task.md`, memory blob и compact summary предыдущих результатов;
- общий живой контекст между попытками разрешён только внутри experiment loop одного task: experiment A → compact → experiment B → compact → selection.
- после `compact_task` текущий task закрыт; любые дополнительные изменения к нему требуют нового task или change request.

### PI Code API и Compact
Каждый stage и каждый task включает PI Code API:
- Перед task создаётся `task.md` с инструкциями
- Compact сжимает контекст stage/task
- После compact модель читает: task.md + memory blob
- Model не читает весь проект — только compact + blob
- Memory blob содержит: паттерны, сигнатуры, связи, индекс файлов

---

## 3. Git API: доступные инструменты

Git API — это внутренний слой extension. Модель не должна выполнять raw git-команды через shell, когда planner активен. Она должна использовать planner tools, а extension уже вызывает нужные git-операции.

### Public git tools

Модель никогда не вызывает raw `git`. Public wrapper tools:

- `planner_git_inspect` — безопасно показать branch/head/dirty/conflicts.
- `planner_git_init` — выполнить `git init` на init/check_git.
- `planner_git_commit` — выполнить `git add -A && git commit`; после этого `requiresMemoryUpdate=true`.
- `planner_git_create_task_branch` — создать/switch task branch.
- `planner_git_create_experiment_branch` — создать/switch experiment branch.
- `planner_git_select_experiment` — выбрать experiment id; merge target остаётся в `state.json`.
- `planner_git_merge_selected_experiment` — merge selected experiment -> current task.
- `planner_git_create_refactor_branch` — создать/switch refactor branch.
- `planner_git_merge_refactor_to_task` — merge refactor -> current task.
- `planner_git_merge_task_to_plan` — merge current task -> plan.
- `planner_git_export_plan_to_output` — export plan branch в output branch исходного repo.
- `planner_git_remove_plan_worktree` — удалить plan worktree на accepted done cleanup.
- `planner_git_cleanup_managed_branches` — удалить managed task/experiment branches; plan branch protected.

Инварианты public git tools:

1. Каждый git wrapper сначала выполняет `runPlannerPreflight`.
2. Если wrapper не разрешён текущим `stage/step`, операция блокируется.
3. Модель может передать id (`taskId`, `attemptId`) и commit/merge message, но не может передать merge target branch.
4. Merge targets всегда берутся из `plans/<plan-id>/state.json`.
5. Любой commit/merge, который меняет `HEAD`, сохраняет state с `requiresMemoryUpdate=true`.
6. `state.lastCheckpointCommit` не обновляется git wrapper. Его обновляет только `planner_memory_sync_checkpoint`.
7. Plan branch нельзя удалить через cleanup/delete helpers.

### Базовые операции

#### `git init`
- Создаёт git репозиторий
- Вызывается на INIT stage, если repo нет
- После init git становится основой системы

#### `git worktree add <path> <branch>`
- Создаёт worktree для плана
- Worktree = изолированная среда агента
- Один plan = один worktree
- Task, experiment и refactor — это ветки внутри plan worktree, а не отдельные worktrees
- Default path: `<project-root>/.pi/pi-code-planner/worktrees/<plan-id>`
- User может выбрать custom worktree root заранее через global/project `settings.json`

#### `git worktree remove <path>`
- Удаляет worktree после завершения плана
- Вызывается после export/merge результата в output branch исходного repo
- Worktree lifecycle не является agent tool: extension выполняет его автоматически при создании plan и при accepted done cleanup

### Управление ветками

#### `git branch <name> <from>`
- Создаёт ветку от указанного base
- Поддерживаемые типы:
  - `plan/<plan-id>` — ветка плана
  - `task/<plan-id>/<task-id>` — ветка таска
  - `experiment/<plan-id>/<task-id>/<attempt-id>` — эксперимент

#### `git branch -d <name>` / `git branch -D <name>`
- `-d` — safe delete, проверяет что ветка merged
- `-D` — force delete
- После merge выбранного experiment в task удаляются все experiment branches этого task:
  - selected experiment уже merged, но может удаляться через общий cleanup
  - unselected experiments считаются abandoned attempts и force-deleted
- После merge refactor в task удаляется refactor branch
- После merge task в plan удаляется task branch и остаточные child branches этого task
- Protected: plan branch не удаляется автоматически

#### `git switch <branch>`
- Переключает на ветку внутри worktree
- Dirty state внутри agent worktree не является проблемой сам по себе
- Dirty state становится проблемой только если текущий stage требует clean checkpoint

### Merge

#### `git merge <source> <target>`
- Merge experiment → task после выбора лучшего кандидата
- Merge task → plan после refactor/verify
- Merge plan → original directory как final output

#### `git merge --no-commit <source> <target>`
- Partial merge для проверки перед commit
- Позволяет увидеть конфликт до фиксации результата

### Commit

#### `git commit -m "<message>"`
- Commit создаётся только когда задача завершена или stage требует checkpoint
- Между commit может быть множество изменений
- Message = summary изменений + compact reference
- Commit через shell запрещён при активном planner; commit создаёт только planner tool

### Status

#### `git status`
- Проверяет clean/dirty worktree
- В agent worktree dirty state разрешён во время активной работы
- Перед переходом stage extension решает, нужен ли clean checkpoint

#### `git diff`
- Просмотр изменений до commit
- Используется для verification, summary эксперимента и выбора кандидата

---

## 4. Состояние проекта

Storage расширения создаётся через PI API:

```
getAgentDir()/extensions/pi-code-planner/
```

Внутри extension storage данные хранятся отдельно для каждого открытого проекта. Нельзя хранить один глобальный `state.json` на все проекты или один общий `state.json` на все plans внутри проекта: это ломает восстановление, путает активные планы и делает восстановление после crash неоднозначным.

### Директория проекта

Каждый project получает стабильную директорию:

```
getAgentDir()/extensions/pi-code-planner/projects/<project-folder-name>-<short-hash>/
```

Где:
- `project-folder-name` — имя открытой папки проекта
- `short-hash` — короткий hash абсолютного пути проекта

Hash нужен, потому что разные проекты могут иметь одинаковое имя папки.

### Структура

Состояние расширения всегда хранится в agent dir:

```
projects/<project-id>/
  project.json
  plans/
    <plan-id>/
      plan.json
      state.json
      plan.md
      discovery.md
      questions.md
      decisions.md
      memory/
        project_patterns.md
        files/index.jsonl
        symbols/index.jsonl
        relations/index.jsonl
      tasks/
        <task-id>/
          task.json
          task.md
          tdd.md
          tests.md
          implementation.md
          verify.md
          experiments/
            <attempt-id>/
              experiment.json
              summary.md
```

Plan worktree хранится отдельно от state. Его расположение настраивается.

По умолчанию:

```
<project-root>/.pi/pi-code-planner/worktrees/<plan-id>/
```

Пользовательский путь:

```
<user-selected-root>/<project-id>/<plan-id>/
```

Правила:
- один plan создаёт ровно один worktree
- task, experiment и refactor являются git-ветками внутри этого worktree
- расположение worktree выбирается из settings, а не из model-facing tool params
- если используется project-local worktree, extension автоматически добавляет `.pi/pi-code-planner/worktrees/` в `.gitignore`
- если используется custom worktree settings root, extension не редактирует `.gitignore`
- extension не должен автоматически игнорировать всю `.pi/`, потому что пользователь может хранить там полезные project-local настройки
- `.gitignore` проверяется по полной строке, а не substring match: `.pi/pi-code-planner/worktrees/` и `./.pi/pi-code-planner/worktrees/` считаются одним правилом
- если точное правило уже есть, extension не меняет `.gitignore`
- если `.gitignore` отсутствует, extension создаёт `.gitignore`
- если точного правила нет, extension добавляет `.pi/pi-code-planner/worktrees/` в конец `.gitignore`
- project-local instructions живут в `.pi/pi-code-planner/instructions/append/`; extension не добавляет эту папку в `.gitignore` автоматически
- пользователь сам решает, версионировать project-local instructions или держать их локально

### `settings.json`

Global settings:

```
getAgentDir()/extensions/pi-code-planner/settings.json
```

Project override settings:

```
<project-root>/.pi/pi-code-planner/settings.json
```

Global settings создаются extension автоматически, если файл отсутствует или был удалён. Project settings являются optional override: extension не обязан создавать их в каждом проекте, чтобы не загрязнять repo.

Effective settings строятся так:

```
default settings -> global settings -> project settings
```

Для `worktree` override применяется целиком:

- если project settings содержит `worktree`, используется project `worktree`
- если project settings не содержит `worktree`, используется global `worktree`
- если global settings отсутствовал, extension пересоздаёт его с default `worktree`

Default:

```json
{
  "worktree": {
    "mode": "project-local"
  }
}
```

Custom global root:

```json
{
  "worktree": {
    "mode": "custom",
    "root": "/mnt/fast/pi-worktrees"
  }
}
```

Custom path layout:

```
<root>/<project-id>/<plan-id>
```

Пример:

```
/mnt/fast/pi-worktrees/project-a-8f31aa10/plan-1
/mnt/fast/pi-worktrees/project-a-8f31aa10/plan-2
/mnt/fast/pi-worktrees/project-b-91bc22de/plan-1
```

Инварианты:

- `planner_create_plan` не принимает public `worktreeRoot`
- модель не выбирает filesystem layout
- settings влияют только на новые plans
- после создания plan итоговый путь фиксируется в `plans/<plan-id>/state.json` как `worktreePath`
- изменение settings не переносит существующие worktrees
- project settings может переопределить global worktree policy для конкретного repo

### `project.json`

`project.json` — постоянная карточка проекта и index plans. Она отвечает только на вопросы: какой это project, какие планы есть в этом project, и какой plan сейчас active.

Пример:

```json
{
  "schemaVersion": 1,
  "projectId": "pi-approval-modes-f1647daa",
  "projectRoot": "/home/m62624/Projects/main/pi-approval-modes",
  "displayName": "pi-approval-modes",
  "activePlanId": "plan-fix-find-command",
  "plans": [
    {
      "planId": "plan-fix-find-command",
      "title": "Fix approval-modes false positive",
      "status": "active"
    }
  ]
}
```

Правила:
- `project.json` не хранит stage/step/worktree/branches
- `plans` хранит только summary всех планов проекта
- подробности плана лежат в `plans/<plan-id>/plan.json`
- execution state плана лежит в `plans/<plan-id>/state.json`
- `activePlanId` показывает, с каким plan работает extension сейчас
- при переключении плана меняется только `activePlanId`; state другого plan не перетирается
- `createdAt` не используется в v3
- `lastOpenedAt` не используется в v3, потому что не помогает модели и создаёт лишние записи

### `plans/<plan-id>/state.json`

`state.json` — восстанавливаемое после crash состояние выполнения конкретного plan. У каждого plan свой `state.json`.

Он отвечает на вопрос: что именно этот plan делает сейчас и какой следующий step должен быть выполнен.

Главная идея: завершённый step нельзя повторять автоматически. Если компьютер выключился после завершения step, extension читает `nextStep` и продолжает с него.

Пример:

```json
{
  "schemaVersion": 1,
  "stage": "discovery",
  "step": "read_project",
  "stepStatus": "completed",
  "nextStep": "write_project_patterns",
  "activeTaskId": null,
  "activeExperimentId": null,
  "worktreePath": "/home/m62624/Projects/main/pi-approval-modes/.pi/pi-code-planner/worktrees/plan-fix-find-command",
  "activeBranches": {
    "base": "main",
    "plan": "plan/plan-fix-find-command",
    "currentTask": null,
    "currentExperiment": null,
    "selectedExperiment": null
  },
  "managedBranches": {
    "tasks": {
      "task-1": {
        "task": "task/plan-fix-find-command/task-1",
        "experiments": [
          "experiment/plan-fix-find-command/task-1/attempt-a",
          "experiment/plan-fix-find-command/task-1/attempt-b"
        ],
        "selectedExperiment": "experiment/plan-fix-find-command/task-1/attempt-a",
        "refactor": null
      }
    }
  },
  "currentBranch": "plan/plan-fix-find-command",
  "mergeTargets": {
    "experimentToTask": null,
    "taskToPlan": null,
    "planToOutput": null
  },
  "lastCheckpointCommit": null,
  "requiresMemoryUpdate": false,
  "memoryUpdateReason": null,
  "requiresCompact": false,
  "requiresUserDecision": false,
  "broken": false,
  "brokenReason": null,
  "blockedReason": null
}
```

Правила:
- `state.json` часто обновляется
- state всегда привязан к конкретному plan
- plan определяется путём `plans/<plan-id>/state.json`, поэтому `activePlanId` внутри state не нужен
- `stage` — крупная стадия: например `init`, `discovery`, `planning`, `execution`, `recovery`, `done`
- `step` — конкретный подшаг внутри stage
- `stepStatus` — состояние подшага: `pending`, `running`, `completed`, `failed`, `blocked`
- `nextStep` показывает следующий допустимый step после завершения текущего
- `activeBranches` хранит реальные имена веток, чтобы модель не решала сама куда merge делать
- `managedBranches` хранит все managed child branches по taskId: task branch, experiment branches, selected experiment branch и refactor branch
- `mergeTargets` хранит ожидаемые merge пары для текущего этапа
- `lastCheckpointCommit` хранит commit, до которого memory уже проверена и обновлена
- `requiresMemoryUpdate=true` означает, что normal flow заблокирован до обновления memory
- `memoryUpdateReason` объясняет, почему memory gate включён: `planner_commit`, `planner_merge`, `external_commit`, `manual_checkout`, `rebase_or_history_rewrite`, `file_hash_changed`
- после restart extension сначала читает `project.json`, берёт `activePlanId`, затем читает `plans/<activePlanId>/state.json`
- после чтения state extension проверяет git/worktree, затем либо продолжает с `nextStep`, либо переходит в recovery
- если state противоречит реальному git/worktree состоянию, planner переходит в recovery stage
- extension не должен повторять `completed` step без явного recovery/user decision
- если expected branch/worktree отсутствует, state помечается `broken=true`, а destructive repair требует решения пользователя
- если branch могла быть переименована, recovery сначала ищет возможный renamed branch по planId/taskId/checkpoint, а не сразу считает plan потерянным
- `lastCheckpointCommit` нельзя обновлять сразу после git commit/merge; сначала нужно обновить и проверить memory checkpoint
- после merge selected experiment -> task extension удаляет selected experiment branch и все остальные experiment branches этого task
- после merge refactor -> task extension удаляет refactor branch
- после merge task -> plan extension удаляет task branch и остаточные child branches этого task
- после удаления всех child branches для task registry entry удаляется из `managedBranches.tasks`

Модель не выбирает merge target. Например, при `select_experiment` модель выбирает только `experimentId`, а extension берёт target из `plans/<plan-id>/state.json`:

```
selected experiment branch -> current task branch
current task branch -> plan branch
plan branch -> output branch
```

### `plans/<plan-id>/plan.json`

`plan.json` — structured index конкретного плана. Он хранит структуру плана, а не runtime execution state.

Пример:

```json
{
  "schemaVersion": 1,
  "planId": "plan-fix-find-command",
  "title": "Fix approval-modes false positive",
  "status": "active",
  "tasks": [
    {
      "taskId": "task-1",
      "title": "Add failing test for blocked find command",
      "status": "pending"
    }
  ]
}
```

Правила:
- `project.json` знает только краткое описание плана
- `plans/<plan-id>/state.json` знает активное execution состояние этого plan
- `plan.json` знает task list и progress конкретного плана
- `plan.json` не хранит current branch/current step/current experiment
- markdown-файлы рядом с `plan.json` являются читаемым контекстом для модели, но не заменяют JSON state

### Переключение планов

Порядок работы extension:

1. Определить opened project root.
2. Вычислить `projectId`.
3. Прочитать `projects/<project-id>/project.json`.
4. Взять `activePlanId`.
5. Прочитать `projects/<project-id>/plans/<activePlanId>/state.json`.
6. Проверить worktree, expected branch, current commit, dirty/conflict state.

Если active plan ожидает ветку, которой больше нет:
- не делать reset/delete/checkout автоматически
- пометить `broken=true`
- записать `brokenReason`
- спросить пользователя, что делать дальше

Возможные user decisions:
- оставить plan broken
- поискать renamed branch
- принять найденный renamed branch
- пересоздать branch из checkpoint, если это безопасно
- переключить active plan
- удалить/reset plan через user command

Модель не выполняет destructive recovery сама.

---

## 5. Машина стадий

Модель всегда должна вызывать navigation/status tool, если не уверена что делать дальше. Этот tool читает `project.json`, затем `plans/<activePlanId>/state.json`, проверяет git/worktree и возвращает единственный допустимый следующий шаг. Модель не должна сама перескакивать stage или выполнять raw git.

### `planner_status`

`planner_status` — будущий главный tool навигации. Он всегда разрешён, если plan активен.

До полной реализации `planner_status` extension должен иметь отдельный wrapper policy слой. Этот слой не строит длинный ответ для модели, а только проверяет: разрешён ли конкретный planner wrapper на текущих `stage/step`.

Tool читает:
- `project.json`
- `plans/<activePlanId>/state.json`
- активный `plan.json`
- git/worktree состояние через внутренний git слой
- memory dirty/checkpoint состояние

Tool возвращает:
- текущие `stage`, `step`, `stepStatus`, `nextStep`
- активные `planId`, `taskId`, `experimentId`
- разрешённые категории действий для текущего step
- заблокированные категории действий и причину
- список markdown instruction keys и exact paths, которые модель должна прочитать
- ссылку на active worktree
- флаг `requiresCompact`
- флаг `requiresUserDecision`

`planner_status` — главный model-facing навигатор. Он не заменяет state machine и не выполняет работу за модель, но обязан вернуть достаточно контекста, чтобы модель не гадала и не забывала прочитать нужные инструкции.

`planner_status` возвращает:
- короткий runtime header;
- persisted state snapshot;
- git/worktree reality;
- memory/checkpoint status;
- next required action;
- exact current step rule;
- allowed planner wrappers;
- allowed state transitions;
- exact instruction file paths;
- собранный instruction bundle для текущего `stage/step`;
- planner artifact links;
- memory-first rule;
- full state machine order;
- global invariants.

Instruction bundle вставляет markdown content только для текущего маршрута:
- default markdown текущего stage;
- project append для этого key, если существует;
- иначе global append для этого key, если существует;
- дополнительные instruction keys текущего step: `memory`, `tdd`, `experiment`, `refactor`, `git`, `git-commit`.

Memory indexes целиком в `planner_status` не вставляются. Вместо этого status возвращает exact paths и жёсткое правило: сначала inspect/retrieve memory, потом читать source code только если memory отсутствует, stale, недостаточна или требует verification.

Правило append:
- если есть project append, модель учитывает `default + project append`;
- если project append отсутствует, модель учитывает `default + global append`;
- если append пустой, остаётся только default.

### Markdown instructions

Для каждого stage/task/experiment создаются markdown artifacts. Они собираются из:
- системного шаблона расширения
- пользовательских настроек проекта
- конкретного `task.md`, `tdd.md`, `verify.md`, `summary.md`
- memory context: `project_patterns.md`, `files/index.jsonl`, `symbols/index.jsonl`, `relations/index.jsonl`

После compact модель должна снова вызвать `planner_status`. Status вернёт текущий instruction bundle и artifact links. Markdown объясняет, как именно выполнять step, например:
- как запускать проверки проекта
- какие test commands использовать: `cargo test`, `npm test`, `pytest`, `go test`
- какие mocks/fixtures допустимы
- какие project conventions соблюдать

`planner_status` вставляет только релевантный текущему `stage/step` markdown bundle. Он не вставляет все artifacts и не вставляет все memory indexes целиком.

### Step rule matrix

Для каждого documented `stage/step` в коде существует exact rule:
- objective;
- required actions;
- allowed now;
- forbidden now;
- exit condition;
- next instruction.

Покрытие обязательно:

```text
init       7 steps
discovery  9 steps
planning   7 steps
execution 15 steps
finalize   4 steps
done       8 steps
recovery   6 steps
total     56 steps
```

`planner_status` обязан вернуть current step rule целиком. Модель не должна выводить разрешения из общих категорий сама.

### Категории действий

Разрешения задаются не по каждому shell command, а по категориям:

- `read_project` — читать project files
- `write_artifacts` — писать planner artifacts: `plan.md`, `task.md`, `tdd.md`, summaries
- `write_memory` — обновлять memory files через planner memory tools. Это action category, а не имя step.
- `write_tests` — писать tests, fixtures, mocks и необходимое подключение тестов
- `write_production` — менять production behavior
- `run_checks` — запускать команды проверки из markdown/settings
- `planner_git` — выполнять git операции только через planner tools
- `raw_git` — всегда запрещён при active plan

Extension не должен пытаться определять корректность изменений через pattern matching путей. В реальном проекте любой файл может быть легитимно изменён ради теста, harness, fixture или интеграции.

Граница безопасности другая: перед `finish_task`, checkpoint или merge extension даёт модели обязательную проверку controlled diff/last commit. Модель должна подтвердить:
- какие файлы были изменены
- зачем каждый файл относится к текущему task
- нет ли случайных изменений вне scope
- не был ли изменён production behavior раньше разрешённого step

Если модель не может объяснить изменение файла, step остаётся в retry/review, а не переходит дальше.

### Retry

Если step завершился неудачно, extension не перескакивает на следующий step. Он оставляет текущий `stage/step`, обновляет `stepStatus=failed` или `blocked`, и `planner_status` возвращает инструкцию retry текущего step.

Retry не создаёт новый global stage. Он остаётся внутри текущего task/experiment scope.

Если во время task модель обнаружила, что для завершения нужны дополнительные мелкие действия, они не становятся новыми global steps. Они записываются в task artifact как local checklist/subtasks и выполняются внутри текущего step, пока не меняют внешний контракт stage machine.

Новый formal step нужен только если:
- действие требует другого набора разрешений
- действие требует compact boundary
- действие меняет git branch/checkpoint
- действие должно пережить crash как отдельная точка восстановления

Иначе это scope текущего step.

### Git guard

Если plan неактивен, extension не вмешивается.

Если plan активен, raw git полностью запрещён во всех stage/step:
- `git status`
- `git diff`
- `git log`
- `git show`
- `git commit`
- `git branch`
- `git switch`
- `git checkout`
- `git merge`
- `git reset`
- `git rebase`
- `git worktree`

Даже read-only git commands запрещены через shell. Если модели нужен status, diff или history, она вызывает `planner_status` или planner git tool. Extension сам выполняет внутренний git read/write и возвращает безопасный результат.

Перед каждым planner tool call extension проверяет git/worktree reality. Если branch, commit, dirty state или checkpoint отличаются от `plans/<activePlanId>/state.json`, normal flow останавливается и включается recovery/discovery_update logic.

### State/Git synchronization contract

Перед любым public planner tool выполняется preflight:

1. Прочитать active `project.json`, `plan.json`, `state.json`.
2. Если active plan отсутствует — extension не вмешивается.
3. Если plan active — прочитать actual git reality из worktree:
   - current branch
   - `HEAD`
   - status/dirty/conflicts
4. Сравнить actual reality с `state.json`.
5. Если branch/worktree/merge targets противоречат state — normal tool не выполняется, перейти в recovery.
6. Если есть conflict — normal tool не выполняется, перейти в recovery.
7. Если `requiresMemoryUpdate=true` — разрешены только status/git inspect/memory update wrappers.
8. Если `HEAD !== state.lastCheckpointCommit` и checkpoint не `null` — normal flow блокируется memory gate.
9. Если всё совпадает — policy проверяет, разрешён ли конкретный wrapper на текущем `stage/step`.

После любого planner git write выполняется post-mutation sync:

1. Прочитать actual branch, `HEAD`, status/conflicts после операции.
2. Обновить `state.currentBranch` по actual branch.
3. Если `HEAD` изменился:
   - не обновлять `state.lastCheckpointCommit`
   - поставить `requiresMemoryUpdate=true`
   - записать `memoryUpdateReason`
4. Если после операции появились conflicts:
   - перейти в `stage=recovery`, `step=inspect_git`
   - поставить `stepStatus=blocked`
   - записать `broken=true`, `brokenReason`, `blockedReason`
5. Сохранить `state.json`.

`lastCheckpointCommit` обновляется только после memory sync:

1. Создать project snapshot.
2. Запустить freshness analysis.
3. Модель обновляет affected memory через memory tools.
4. Freshness снова `clean=true`.
5. Записать memory checkpoint с current `HEAD`.
6. Обновить:

```json
{
  "lastCheckpointCommit": "current-head",
  "requiresMemoryUpdate": false,
  "memoryUpdateReason": null
}
```

Инвариант:

```
Любой git write tool возвращает уже синхронизированный state.
Если state нельзя синхронизировать, normal flow считается blocked.
Модель никогда не правит state.json вручную.
```

### Runtime reality evaluator

Перед state machine стоит отдельный слой `evaluatePlannerRuntimeReality(...)`.

Его задача — не двигать stage/step и не писать файлы, а принять уже собранные факты:
- статус active plan context;
- `state.json`;
- actual git reality;
- memory gate inspection;
- признак валидности memory checkpoint;
- признак существования worktree.

И вернуть одно детерминированное решение:
- `no_active_plan` — plan отсутствует, extension не вмешивается в normal Pi flow;
- `allow_stage_machine` — storage, git и memory согласованы, можно проверять текущий stage/step;
- `require_memory_update` — normal stage/step временно заблокирован, модель должна обновить memory;
- `require_compact` — текущий атомарный boundary завершён, нужен compact/resume flow;
- `require_recovery` — state/worktree/git противоречат друг другу, нужен recovery;
- `require_user_decision` — продолжение требует решения пользователя.

Порядок приоритетов:

1. Если active plan отсутствует — вернуть `no_active_plan`.
2. Если `plan.json` или `state.json` missing — `require_recovery`.
3. Если `state.requiresUserDecision=true` — `require_user_decision`.
4. Если `state.broken=true` — `require_recovery`.
5. Если worktree path отсутствует или worktree удалён — `require_recovery`.
6. Если memory checkpoint повреждён — `require_recovery`.
7. Если git reality недоступна — `require_recovery`.
8. Если есть git conflicts — `require_recovery`.
9. Если actual branch не совпадает с `state.currentBranch` — `require_recovery`.
10. Если `state.requiresMemoryUpdate=true` — `require_memory_update`.
11. Если `HEAD !== state.lastCheckpointCommit` — `require_memory_update` с reason `external_commit`, если это не было уже помечено planner git wrapper.
12. Если memory gate показывает file hash mismatch/new/missing files — `require_memory_update` с reason `file_hash_changed`.
13. Если `state.requiresCompact=true` — `require_compact`.
14. Иначе — `allow_stage_machine`.

Этот слой также возвращает `allowedTools`, но сам не решает, можно ли конкретный wrapper выполнить. Конкретный wrapper проверяется следующим policy слоем.

Важно:

```
Runtime reality evaluator не делает recovery, compact, git reset, commit, merge или file writes.
Он только выбирает gate: stage machine, memory update, compact, recovery, user decision или no active plan.
```

### Preflight orchestrator

`runPlannerPreflight(...)` — слой, который реально собирает runtime facts перед `planner_status`, state machine и public planner wrappers.

Он выполняет порядок:

1. Прочитать active plan context через `project.json -> activePlanId -> plan.json/state.json`.
2. Если active plan отсутствует — вернуть `no_active_plan` и не трогать git.
3. Если `plan.json` или `state.json` missing — вернуть recovery и не трогать git.
4. Если текущий step находится в раннем `init` до создания worktree — разрешить state machine без git/memory inspection.
5. Если worktree уже должен существовать, но отсутствует — вернуть recovery.
6. Прочитать git reality из planner worktree:
   - branch;
   - HEAD;
   - porcelain status;
   - conflict flag.
7. Если git reality недоступна, branch wrong или есть conflicts — вернуть recovery без memory gate.
8. Проверить memory checkpoint integrity.
9. Если checkpoint corrupted — вернуть recovery без memory gate.
10. Запустить memory gate/freshness inspection только если он нужен сейчас:
   - `state.requiresMemoryUpdate=true`;
   - `HEAD !== state.lastCheckpointCommit`;
   - `state.requiresCompact=true`;
   - текущий step является compact boundary;
   - текущий step является stage boundary `enter_*`.
11. Передать всё в `evaluatePlannerRuntimeReality(...)`.
12. Если runtime decision = `require_memory_update`, записать в `state.json` `requiresMemoryUpdate=true` и `memoryUpdateReason`.
13. Повторно оценить runtime decision уже с синхронизированным state.
14. Вернуть `decision`, `allowedTools`, context, git reality, memory checkpoint и memory gate.

Uncommitted edits во время обычного work step не должны сами по себе включать memory gate. Иначе модель не сможет дойти до commit: working tree уже отличается от memory, но atomic step ещё не закончен. Working-tree freshness становится blocking только на checkpoint/boundary или после git `HEAD` change.

`checkPlannerPreflightToolAllowed(...)` проверяет конкретный planner wrapper уже после runtime decision. Это важно, потому что `requiresMemoryUpdate` может быть вычислен preflight-слоем из actual git/memory reality, даже если в `state.json` флаг ещё не стоял.

`planner_status` должен использовать preflight formatter и показывать короткий routing snapshot:
- runtime action;
- reason;
- stage/step/nextStep;
- active plan;
- worktree;
- git branch/head;
- allowed planner wrappers;
- allowed state transitions: `start_step`, `complete_step`, `advance_step`, `fail_step`, `block_step`, `retry_step`, `request_compact`, `complete_compact`, когда они допустимы в текущем state;
- напоминание читать markdown текущего stage.

`planner_status` не должен сам менять workflow state, кроме одного безопасного случая: если preflight обнаружил stale memory, он обязан записать gate в `state.json`:

```json
{
  "requiresMemoryUpdate": true,
  "memoryUpdateReason": "external_commit"
}
```

Это нужно, чтобы после внезапного выключения или нового tool call система не потеряла факт, что git/memory уже рассинхронизированы.

### State machine core

`state-machine` — pure слой поверх `PlanStateRecord`. Он не читает git/fs, не сохраняет `state.json` и не вызывает Pi API.

Его задача — строго менять runtime state:
- `startPlannerStep` — `pending/failed -> running`;
- `completePlannerStep` — `running -> completed` и записать допустимый `nextStep`;
- `advancePlannerStep` — перейти с `completed` на записанный `nextStep`;
- `failPlannerStep` — оставить текущий position, поставить `failed`;
- `blockPlannerStep` — оставить текущий position, поставить `blocked`;
- `retryPlannerStep` — `failed/blocked -> pending`;
- `requestPlannerCompact` — включить `requiresCompact` только на compact steps;
- `completePlannerCompact` — завершить compact step после `session_compact`;
- `enterPlannerRecovery` — перевести state в `recovery/read_state`;
- `resumePlannerAfterRecovery` — вернуться из recovery в явный valid non-recovery position.

Инварианты:

1. Completed step нельзя запускать повторно. Нужно сначала `advancePlannerStep`.
2. Normal flow нельзя стартовать, если state имеет `broken`, `requiresUserDecision`, `requiresMemoryUpdate` или `requiresCompact`.
3. Обычные steps имеют ровно один следующий step.
4. Stage boundary возможен только через documented `enter_*` steps.
5. Decision steps требуют явный allowed target:
   - `execution/select_next_task` -> `execution/prepare_task` или `finalize/verify_plan_branch`;
   - `done/await_user_acceptance` -> `done/handle_change_request` или `done/prepare_output_branch`;
   - `done/handle_change_request` -> `planning/read_memory`.
6. `recovery` — исключение из обычного strict order. Recovery может вернуться только через `resumePlannerAfterRecovery` в valid non-recovery position.
7. `cleanup_plan_files` — terminal step: после completed state `nextStep=null`, `advancePlannerStep` остаётся no-op.

Public planner tools должны использовать порядок:

```
runPlannerPreflight
-> check runtime action
-> check wrapper allowed
-> state-machine transition
-> save state.json
```

Старые low-level storage helpers вроде прямого `setPlanStep` или `completePlanStep` не должны быть публичным workflow API. Они допустимы только как низкоуровневые persistence primitives или в миграциях/тестах.

### Persisted state transition

`applyPlannerStateTransition(...)` склеивает preflight, wrapper policy, state machine и `savePlanState`.

Слой принимает:
- `PlannerPreflightResult`;
- transition type: `start_step`, `complete_step`, `advance_step`, `fail_step`, `block_step`, `retry_step`, `request_compact`, `complete_compact`, `enter_recovery`, `resume_after_recovery`;
- optional wrapper tool name.

Порядок:

1. Если active context не `ready`, вернуть `blocked/context_not_ready`, ничего не сохранять.
2. Если указан wrapper tool, проверить `checkPlannerPreflightToolAllowed`.
3. Если runtime action не разрешает transition, вернуть `blocked/runtime_blocked`.
4. Вызвать pure state machine transition.
5. Если state machine вернула ошибку, вернуть `blocked/state_machine_error`, ничего не сохранять.
6. Только после успешного transition сохранить `state.json`.

Runtime gates:
- normal transitions разрешены только при `allow_stage_machine`;
- `complete_compact` разрешён только при `require_compact`;
- `enter_recovery` и `resume_after_recovery` разрешены при `allow_stage_machine`, `require_recovery` или `require_user_decision`.

Этот слой всё ещё не является public Pi tool. Это internal adapter, который должны использовать будущие workflow/git/memory/recovery tools.

### Public workflow transition tools

Public workflow tools — тонкая оболочка над `applyPlannerStateTransition(...)`.

Они не решают сами, можно ли двигаться дальше. Каждый вызов делает:

```
runPlannerPreflight
-> applyPlannerStateTransition
-> savePlanState on success
-> text result with next planner_status instruction
```

Доступные workflow tools:

- `planner_start_step` -> `start_step`;
- `planner_complete_step` -> `complete_step`;
- `planner_advance_step` -> `advance_step`;
- `planner_fail_step` -> `fail_step`;
- `planner_block_step` -> `block_step`;
- `planner_retry_step` -> `retry_step`;
- `planner_request_compact` -> `request_compact`;
- `planner_complete_compact` -> `complete_compact`.
- `planner_enter_recovery` -> `enter_recovery`;
- `planner_resume_after_recovery` -> `resume_after_recovery`.

Модель не должна угадывать порядок этих tools. Она вызывает `planner_status`, читает `Allowed state transitions`, затем вызывает только соответствующий workflow tool.

Если transition заблокирован, tool возвращает `blocked` и причину: context not ready, runtime gate, wrapper policy или state-machine error.

### Public memory tools

Memory tools — public wrappers, через которые модель обновляет memory blob. Модель не правит memory JSONL напрямую.

Доступные memory tools:

- `planner_memory_inspect` — построить snapshot, показать `filesToReindex`, affected symbols/relations и required checks.
- `planner_memory_apply_freshness` — пометить stale/missing entries dirty/missing перед переписыванием memory.
- `planner_memory_write_batch` — записать validated file/symbol/relation entries.
- `planner_memory_verify` — проверить, что memory совпадает с текущим project snapshot.
- `planner_memory_sync_checkpoint` — если memory clean, записать checkpoint на current `HEAD`, обновить `state.lastCheckpointCommit`, снять `requiresMemoryUpdate`.

Инвариант memory tools:

1. Любой memory tool сначала выполняет `runPlannerPreflight`.
2. Если policy не разрешает memory tool — tool возвращает `blocked`.
3. Если memory tool меняет memory index files, он сразу переписывает checkpoint hashes с тем же checkpoint commit.
4. `planner_memory_sync_checkpoint` запрещён, пока freshness не clean.
5. `planner_memory_sync_checkpoint` — единственный memory tool, который переносит `state.lastCheckpointCommit` на current `HEAD`.

Это предотвращает ложный recovery: частичное обновление memory меняет JSONL hashes, но это плановое изменение, а не corruption.

### Planner wrapper policy

`planner_status` пока не обязан быть полной реализацией маршрутизатора. До него нужен отдельный policy слой, который не читает Pi API и не выполняет git, а только отвечает на вопрос: можно ли сейчас вызвать конкретный planner wrapper.

Policy input:
- текущий `stage`
- текущий `step`
- `stepStatus`
- `requiresCompact`
- `requiresMemoryUpdate`
- `requiresUserDecision`
- `broken`
- имя wrapper tool

Policy output:
- `allow=true/false`
- текущие `stage/step`
- список разрешённых wrappers
- короткая причина блокировки
- короткая подсказка модели: прочитать markdown текущего stage/step и не использовать raw git

Этот слой нужен, чтобы каждый будущий public tool был тонкой оболочкой:
1. прочитать active project/plan/state
2. проверить git/worktree reality
3. вызвать wrapper policy
4. если wrapper запрещён, вернуть причину и подсказку
5. если wrapper разрешён, выполнить state-bound operation
6. сохранить обновлённый `plans/<plan-id>/state.json`

Важно: policy не должен знать source/target branch для merge. Merge targets берутся только из `state.json`. Модель может выбрать `taskId` или `attemptId`, но не может сама указать `experiment -> task`, `task -> plan` или `plan -> output`.

### Stage 1: `init`

Цель: подготовить project storage, git и plan worktree.

В normal flow эта стадия выполняется атомарно внутри `planner_create_plan`. Модель не проходит init руками. После успешного `planner_create_plan` state уже должен быть `discovery/read_project`.

Подшаги:

1. `check_project` — определить root открытого проекта и project id.
2. `check_git` — проверить, есть ли git repo; если нет, planner предлагает/выполняет git init через controlled tool.
3. `prepare_storage` — создать или загрузить `project.json` и директории проекта.
4. `choose_worktree_location` — выбрать расположение для plan worktree: project-local по умолчанию или custom.
5. `create_plan_record` — создать `plan.json`, `state.json`, `plan.md`, базовые artifacts и краткое описание в `project.json`.
6. `create_plan_worktree` — создать один git worktree для всего plan.
7. `enter_discovery` — обновить `plans/<plan-id>/state.json`: `stage=discovery`, `step=read_project`.

### Stage 2: `discovery`

Цель: изучить проект и создать memory blob, чтобы дальше модель не перечитывала весь проект.

Подшаги:

1. `read_project` — прочитать структуру и релевантные файлы проекта.
2. `write_project_patterns` — записать архитектурные паттерны и conventions в `project_patterns.md`.
3. `write_file_index` — записать индекс файлов в `memory/files/index.jsonl`.
4. `write_symbols` — записать сигнатуры функций, типов, классов, публичных API в `memory/symbols/index.jsonl`.
5. `write_relations` — записать связи между файлами, символами и модулями в `memory/relations/index.jsonl`.
6. `write_questions` — записать вопросы и неопределённости в `questions.md`.
7. `verify_memory` — проверить, что memory entries действительно ссылаются на существующие файлы и symbols.
8. `compact_discovery` — выполнить compact boundary после discovery.
9. `enter_planning` — обновить `plans/<plan-id>/state.json`: `stage=planning`, `step=read_memory`.

### Stage 3: `planning`

Цель: построить исполнимый план на основе discovery и memory.

Подшаги:

1. `read_memory` — прочитать compact + memory blob, а не весь проект заново.
2. `draft_plan` — записать общий план в `plan.md`.
3. `split_tasks` — разбить работу на atomic tasks.
4. `write_task_files` — создать `tasks/<task-id>/task.json` и `task.md` для каждого task.
5. `verify_plan` — проверить, что tasks атомарные, упорядоченные и имеют чёткие acceptance criteria.
6. `compact_planning` — выполнить compact boundary после planning.
7. `enter_execution` — обновить `plans/<plan-id>/state.json`: `stage=execution`, `step=prepare_task`.

### Stage 4: `execution`

Цель: выполнить каждый task через TDD, эксперименты, выбор кандидата, refactor и merge в plan branch.

Подшаги для каждого task:

1. `prepare_task` — выбрать следующий task, создать или переключить task branch, загрузить task artifacts.
2. `write_tdd_plan` — записать TDD план до любых production edits.
3. `write_tests` — написать failing/mock/contract tests до production code.
4. `run_failing_tests` — подтвердить, что тесты действительно проверяют требование и падают/ловят отсутствие реализации.
5. `start_experiments` — создать список попыток эксперимента и первый experiment branch.
6. `run_experiment` — реализовать один подход в experiment branch.
7. `summarize_experiment` — записать summary, git diff summary и результат проверки experiment. Отдельный `diff.md` artifact не создаётся: diff берётся через planner git wrapper.
8. `compact_experiment` — выполнить compact boundary перед следующим experiment или selection.
9. `select_experiment` — модель выбирает лучший `experimentId`; merge target берётся из `plans/<plan-id>/state.json`.
10. `merge_best_experiment` — extension merge выбранный experiment branch в current task branch.
11. `refactor_task` — улучшить код на task branch без изменения поведения.
12. `run_final_tests` — прогнать финальные проверки task branch.
13. `merge_task_to_plan` — extension merge current task branch в plan branch.
14. `compact_task` — выполнить compact boundary после завершения task.
15. `select_next_task` — выбрать следующий task или перейти в finalize.

Инварианты task loop:

1. В execution активен только один `taskId`.
2. `prepare_task` выбирает один task и делает его единственным active task.
3. `select_next_task` запрещён, пока current task не прошёл `merge_task_to_plan` и `compact_task`.
4. После `compact_task` следующий task не наследует живой chat/context предыдущего task.
5. Следующий task обязан заново читать актуальные artifacts и memory через `planner_status`.
6. Experiment attempts внутри одного task могут использовать compact summary предыдущих attempts, потому что они сравнивают альтернативы одной и той же задачи.
7. Между разными tasks общий контекст передаётся только через compacted artifacts, memory и plan branch state.

### Stage 5: `finalize`

Цель: проверить plan branch и подготовить результат к user review.

Подшаги:

1. `verify_plan_branch` — проверить, что plan branch содержит все merged tasks и проходит финальные проверки.
2. `write_final_summary` — записать summary результата, git diff summary, проверки, known risks и список изменённых файлов.
3. `compact_finalize` — выполнить compact boundary перед user acceptance.
4. `enter_done` — обновить `plans/<plan-id>/state.json`: `stage=done`, `step=present_result`.

### Stage 6: `done`

Цель: получить решение пользователя по готовому результату и либо отправить plan на доработку, либо вывести одну чистую ветку в рабочий repo.

`done` — это реальный stage, а не просто terminal marker. На этом этапе model не пишет новый production code. Она показывает результат, ждёт user decision и следует controlled tools.

Подшаги:

1. `present_result` — показать user summary результата: что сделано, какие проверки прошли, где лежит plan branch/worktree, какие риски остались.
2. `await_user_acceptance` — остановиться и получить решение пользователя: accept или request changes.
3. `handle_change_request` — если user не принимает результат, записать feedback в plan artifacts и перейти обратно в `planning` внутри того же plan worktree и plan branch.
4. `prepare_output_branch` — если user принимает результат, создать или обновить output branch в исходном repo проекта.
5. `merge_or_export_result` — перенести итог plan branch из plan worktree в output branch исходного repo.
6. `cleanup_worktree` — удалить plan worktree и временные managed branches, которые безопасно удалять.
7. `mark_done` — обновить `project.json`: сбросить `activePlanId`, пометить plan как завершённый/удалённый, записать имя output branch.
8. `cleanup_plan_files` — удалить `plans/<plan-id>/` из agent storage: `plan.json`, `state.json`, markdown artifacts, memory, task files и experiment summaries.

Правила:
- если user просит изменения, worktree не удаляется
- change request не создаёт новый root project state; он продолжает текущий plan
- после change request planner возвращается в `planning`, потому что нужно пересобрать task list на основе feedback
- destructive cleanup выполняется только после explicit accept
- `mark_done` выполняется до `cleanup_plan_files`, чтобы crash между этими шагами можно было восстановить
- после `cleanup_plan_files` директории `plans/<plan-id>/` больше нет; старые planner artifacts не являются source of truth
- после успешного done у user остаётся только одна output branch в обычном рабочем repo, рядом с остальными git branches; user сам решает merge/rebase/delete
- plan worktree удалён, временные managed branches удалены, agent storage plan files удалены
- `project.json` может сохранить только минимальную историческую запись о завершённом plan, но не содержит runtime state

### Stage 7: `recovery`

Цель: восстановить planner после crash, ручных git изменений или несовпадения state с реальностью.

Подшаги:

1. `read_state` — прочитать `project.json`, `plans/<activePlanId>/state.json`, активный `plan.json`.
2. `inspect_git` — проверить repo, worktree, current branch, commits, dirty/conflict state.
3. `compare_expected_actual` — сравнить реальное git-состояние с `plans/<activePlanId>/state.json`: expected branch, worktree path, checkpoint commit, merge targets.
4. `classify_recovery` — определить тип проблемы: missing worktree, wrong branch, dirty checkpoint, external commit, conflict, missing plan files.
5. `ask_user_if_destructive` — если repair требует удаления, reset или force operation, спросить пользователя; модель не принимает destructive решение сама.
6. `repair_or_resume` — выполнить безопасное восстановление или вернуться к stage/step/nextStep из `plans/<activePlanId>/state.json`.

---

## 6. Memory System

Memory System — это сжатая knowledge base проекта для локальной модели. Она нужна, чтобы модель не перечитывала весь проект после каждого compact, rebase, checkout или task.

Memory не заменяет source code. Memory хранит минимальную безопасную информацию:
- какие файлы существуют
- какие API/signatures есть в этих файлах
- какие symbols связаны друг с другом
- какие functions/types имеют side effects
- какие memory entries устарели после git/filesystem изменений

### Главный принцип

Git отвечает за историю и ветки. Memory отвечает за фактическое состояние файлов и API.

```
Git commit hash = checkpoint истории
File hash = checkpoint содержимого файла
Symbol anchor = способ найти API без line numbers
Memory dirty state = список файлов, чьи compressed entries нужно обновить
```

Это важно для rebase: commit hash может измениться, но file hashes показывают, что реально поменялось.

### Структура

Memory живёт внутри конкретного plan:

```
plans/<plan-id>/memory/
  project_patterns.md
  files/index.jsonl
  symbols/index.jsonl
  relations/index.jsonl
  dirty.json
  checkpoints/
    latest.json
```

Для v3 достаточно одного `symbols/index.jsonl`. Sharding можно добавить позже как внутреннюю оптимизацию, если файл станет слишком большим.

### Retrieval limits

Memory нельзя отдавать модели целиком без лимитов. Даже если memory хранится в JSONL, tool result всегда должен быть bounded chunk.

Правило:

```
Модель получает только ограниченный memory context.
Если нужно больше, она повторяет поиск с cursor/offset или уточняет query.
```

Базовый retrieval API:

```ts
retrieveMemoryContext({
  query?: string,
  cursor?: {
    files?: number,
    symbols?: number,
    relations?: number
  },
  limits?: {
    files?: number,
    symbols?: number,
    relations?: number
  },
  filters?: {
    paths?: string[],
    languages?: string[],
    symbolKinds?: string[],
    relationKinds?: string[],
    globalState?: string[],
    verificationStatus?: string[],
    dirtyOnly?: boolean
  }
})
```

Ответ:

```ts
{
  files: { entries, totalMatched, start, limit, nextCursor },
  symbols: { entries, totalMatched, start, limit, nextCursor },
  relations: { entries, totalMatched, start, limit, nextCursor }
}
```

Правила:
- `nextCursor=null` означает, что chunk для этой категории закончился
- default limit небольшой, чтобы не раздувать context
- max limit жёстко ограничен кодом
- project patterns и dirty state добавляются только если caller явно запросил
- retrieval сначала exact/structured/lexical; vector RAG можно добавить позже как backend, не меняя внешний API
- для больших проектов модель должна уточнять query или читать следующий chunk, а не просить весь memory blob

### `files/index.jsonl`

Файловый индекс хранит минимальную информацию о файлах проекта.

Пример записи:

```json
{
  "path": "src/config.ts",
  "kind": "source",
  "language": "ts",
  "hash": "sha256-file-content",
  "status": "indexed",
  "summary": "Configuration parsing and validation."
}
```

Поля:
- `path` — relative path от project root
- `kind` — `source`, `test`, `config`, `docs`, `generated`, `vendor`, `unknown`
- `language` — язык или `unknown`
- `hash` — hash содержимого файла на момент indexing
- `status` — `pending`, `indexed`, `dirty`, `ignored`, `missing`, `failed`
- `summary` — короткое описание файла для модели

Правила:
- line numbers не храним
- absolute paths не храним внутри memory entries
- если current file hash отличается от stored hash, файл становится dirty
- ignored files берутся из gitignore и planner worktree ignore rules

### `symbols/index.jsonl`

Symbol index хранит API/signatures. Это главная часть memory.

Пример записи:

```json
{
  "id": "sym_parse_config",
  "path": "src/config.ts",
  "language": "ts",
  "kind": "function",
  "name": "parseConfig",
  "qualifiedName": "parseConfig",
  "signature": "function parseConfig(input: string): Config",
  "summary": "Parses raw config text into Config.",
  "visibility": "public",
  "effects": {
    "reads": [],
    "writes": [],
    "io": [],
    "globalState": "none"
  },
  "anchor": {
    "searchText": "function parseConfig(input: string): Config"
  },
  "verification": {
    "fileHash": "sha256-file-content",
    "status": "verified"
  }
}
```

Поля:
- `id` — stable symbol id внутри plan memory
- `path` — relative file path
- `language` — язык или `unknown`
- `kind` — `function`, `method`, `type`, `class`, `trait`, `interface`, `module`, `constant`, `test`, `unknown`
- `name` — short name
- `qualifiedName` — language-specific full name если есть
- `signature` — compact signature, без body
- `summary` — короткое описание поведения
- `visibility` — `public`, `package`, `crate`, `private`, `test_only`, `unknown`
- `effects` — side effects и state dependencies
- `anchor.searchText` — текст, по которому можно найти symbol в файле
- `verification.fileHash` — hash файла, где symbol был проверен
- `verification.status` — `verified`, `stale`, `missing`, `unverified`

### Effects

`effects` описывает, влияет ли symbol на state или внешний мир. Это language-neutral поле: оно подходит для TypeScript, Rust, Go, Python и других языков.

Примеры:

Чистая функция:

```json
{
  "reads": [],
  "writes": [],
  "io": [],
  "globalState": "none"
}
```

Функция читает окружение:

```json
{
  "reads": ["process.env.CONFIG_PATH"],
  "writes": [],
  "io": [],
  "globalState": "reads"
}
```

Функция меняет global cache и пишет файл:

```json
{
  "reads": ["global.cache"],
  "writes": ["global.cache"],
  "io": ["filesystem:write"],
  "globalState": "writes"
}
```

Допустимые значения `globalState`:
- `none` — нет известной зависимости от global/external state
- `reads` — читает global/external state
- `writes` — пишет global/external state
- `unknown` — модель не смогла безопасно определить

Правила:
- если нет уверенности, использовать `unknown`
- не выдумывать точные internals без evidence
- effects используются planning/TDD для оценки риска и стратегии тестов
- функции с `writes` или `unknown` требуют более строгих тестов и меньших tasks

### `relations/index.jsonl`

Relations описывают полезные graph-связи между symbols и файлами.

Пример:

```json
{
  "id": "rel_parse_config_tests",
  "from": "sym_parse_config_tests",
  "to": "sym_parse_config",
  "kind": "tests",
  "evidencePath": "src/config.test.ts",
  "evidenceSearchText": "parseConfig("
}
```

Допустимые relation kinds:
- `calls`
- `implements`
- `extends`
- `contains`
- `returns`
- `accepts`
- `throws`
- `reads`
- `writes`
- `tests`
- `configures`
- `depends_on`
- `exposes`
- `unknown`

Правила:
- relation должна иметь evidence path
- если target symbol неизвестен, `to` может быть `null`
- relations — это подсказки для compact context, а не compiler graph

### `dirty.json`

Dirty memory state хранит файлы, которым нужен discovery update.

Пример:

```json
{
  "files": {
    "src/config.ts": {
      "reason": "file hash changed after git checkout",
      "detectedAt": "2026-05-22T10:00:00.000Z"
    }
  }
}
```

Причины dirty:
- `file_hash_changed`
- `git_status_changed`
- `external_commit`
- `rebase_or_history_rewrite`
- `manual_checkout`
- `symbol_missing`
- `verification_failed`

Правила:
- dirty file блокирует steps, которые опираются на stale memory
- dirty file не блокирует всю работу автоматически
- затронутая memory должна быть обновлена перед compact или перед использованием связанных symbols как trusted context

### Memory checkpoint

`checkpoints/latest.json` — минимальная контрольная точка консистентности memory.

Пример:

```json
{
  "commit": "abc123",
  "filesIndexHash": "sha256-files-index",
  "symbolsIndexHash": "sha256-symbols-index",
  "relationsIndexHash": "sha256-relations-index"
}
```

Правила:
- checkpoint сам по себе не source of truth
- checkpoint помогает обнаружить memory corruption или неожиданные перезаписи
- если checkpoint hashes не совпадают с текущими memory files, перейти в recovery
- если git history переписана, file hashes всё равно определяют, какие memory entries стали stale

### Discovery update

`discovery_update` используется, когда project files изменились после построения memory.

Триггеры:
- current commit изменился вне planner flow
- rebase/merge/manual checkout изменили file hashes
- dirty files существуют перед compact
- symbol verification возвращает `missing`
- пользователь изменил файлы при активном плане

Flow:

1. Сравнить текущие файлы с `files/index.jsonl`.
2. Отметить changed/missing/new files в `dirty.json`.
3. Модель читает только dirty files и связанные memory entries.
4. Модель обновляет file entries, symbols, relations и questions.
5. Проверить обновлённые symbols через anchors.
6. Очистить dirty flags для обновлённых файлов.
7. Записать новый checkpoint.
8. Продолжить исходный stage/step.

### Memory freshness verification

Перед compact, после git checkout/merge/rebase или после внешнего изменения файлов extension должен проверить, не устарел ли memory blob.

Проверка работает через snapshot текущих project files. Snapshot строится из git, а не из полного рекурсивного filesystem scan:

```bash
git ls-files --cached --others --exclude-standard
```

Это означает:
- tracked files входят в snapshot
- untracked files входят в snapshot
- ignored files не входят в snapshot
- если tracked file удалён с диска, он не попадает в `files`, но попадает в `missingFiles`
- новые файлы, созданные моделью до commit, видны как `newFiles` при freshness analysis

```ts
[
  { path: "src/config.ts", hash: "sha256-current-file-content" }
]
```

API:

```ts
analyzeMemoryFreshness({
  currentFiles
})
```

Read-only результат:

```ts
{
  clean: false,
  unchangedFiles: ["src/env.ts"],
  changedFiles: ["src/config.ts"],
  missingFiles: ["src/server.ts"],
  newFiles: ["src/new.ts"],
  affectedSymbolIds: ["sym_parse_config"],
  affectedRelationIds: ["rel_server_config"],
  filesToReindex: ["src/config.ts", "src/new.ts", "src/server.ts"]
}
```

Mutating API:

```ts
applyMemoryFreshness({
  currentFiles,
  detectedAt
})
```

Что делает `applyMemoryFreshness`:
- changed indexed files получает `status=dirty`
- missing indexed files получает `status=missing`
- symbols из changed files получают `verification.status=stale`
- symbols из missing files получают `verification.status=missing`
- changed/new files пишутся в `dirty.json` с reason `file_hash_changed`
- missing files пишутся в `dirty.json` с reason `verification_failed`

Что API не делает:
- не читает project source files сам
- не создаёт file/symbol/relation entries за модель
- не удаляет missing entries автоматически
- не делает git recovery

Модель после этого должна прочитать только `filesToReindex` и связанные entries через bounded retrieval, затем обновить memory через batch write API.

### Effects freshness

Effects являются частью memory freshness. Если файл изменился, модель обязана переоценить effects для каждого affected symbol, а не только signature и summary.

Required memory checks для changed/new/missing files:

```text
file_index
symbols
relations
effects
```

Effects update обязателен, потому что изменение внешнего состояния может быть невидимо в signature:
- функция стала читать env/config/process/global state
- функция стала писать global cache/state
- появился filesystem/network/database/UI IO
- появилась зависимость от time/random/current working directory
- symbol начал вызывать другой side-effectful symbol
- changed relation меняет observable behavior callers/tests

Правила:
- если модель не уверена, использовать `globalState="unknown"`
- не ставить `globalState="none"` без evidence
- uncertainty записывать в summary/questions
- effects должны обновляться до memory checkpoint sync
- task planning/TDD использует effects как risk signal

Memory gate всегда возвращает required checks `file_index`, `symbols`, `relations`, `effects`, если memory stale.

### Commit tracking and memory gate

Snapshot по file hashes отвечает на вопрос:

```
Memory соответствует текущему содержимому файлов или нет?
```

Git commit tracking отвечает на другой вопрос:

```
Почему изменилось состояние repo и это сделал planner или внешний пользователь?
```

Обе проверки обязательны. Нельзя использовать только `git diff`, потому что после commit рабочее дерево может быть clean, но memory всё ещё stale.

Главный инвариант:

```
state.lastCheckpointCommit = commit, до которого memory уже проверена и обновлена.
memory checkpoint commit = commit, для которого indexes были записаны.
```

Если `HEAD !== state.lastCheckpointCommit`, planner не имеет права считать memory актуальной только потому, что `git diff` пустой.

Текущий preflight уже делает минимальную синхронизацию state:

1. Если `HEAD !== state.lastCheckpointCommit` и checkpoint существует, action становится `require_memory_update`.
2. Если file hashes в memory index не совпадают с actual project snapshot на boundary/checkpoint step, action становится `require_memory_update`.
3. Preflight сохраняет `requiresMemoryUpdate=true` и причину в `state.json`.
4. Actual memory entries не переписываются автоматически. Модель должна обновить affected files/symbols/relations/effects через memory tools, затем отдельный sync переносит checkpoint на current `HEAD`.

Это закрывает случай, когда commit уже сделан и `git diff` пустой: stale memory всё равно обнаруживается через `HEAD` и file hash snapshot.

До commit обычные uncommitted edits не являются memory corruption. Они являются рабочим состоянием текущего step. После commit/merge git wrapper ставит `requiresMemoryUpdate=true`, и только тогда memory update становится обязательным gate.

Memory checkpoint sync разрешён только на clean worktree. Если в worktree есть staged/unstaged/untracked изменения, `planner_memory_sync_checkpoint` обязан заблокироваться и сказать модели сначала сделать planner-controlled commit. Иначе memory может быть записана под содержимое файлов, которое ещё не закреплено в git `HEAD`.

#### После planner commit

Когда planner сам делает commit через wrapper:

1. Выполнить commit.
2. Прочитать новый `HEAD`.
3. Построить project snapshot через `git ls-files --cached --others --exclude-standard`.
4. Запустить `analyzeMemoryFreshness(snapshot)`.
5. Если `clean=false`, перейти в memory/discovery update и не делать compact.
6. Модель обновляет affected memory entries через memory batch tools.
7. Проверить freshness ещё раз.
8. Проверить, что worktree clean.
9. Записать memory checkpoint с новым `HEAD`.
10. Обновить `state.lastCheckpointCommit = HEAD`.
11. Только после этого разрешить compact или переход stage.

То есть commit не завершает atomic step. Atomic step завершён только когда code, tests, git commit и memory checkpoint согласованы.

#### Если planner сделал merge commit

Merge commit обрабатывается так же, как обычный planner commit:

1. После merge прочитать `HEAD`.
2. Построить snapshot.
3. Сравнить file hashes с memory indexes.
4. Обновить memory для changed/new/missing files.
5. Записать checkpoint на merge commit.

Extension не должен пытаться вручную угадать diff merge commit по родителям, если snapshot уже показывает фактическое состояние файлов. Parent diff может использоваться только как diagnostic/summary, не как source of truth для memory freshness.

#### Если commit появился извне

Перед каждым planner tool call extension сравнивает:

```
actual HEAD
state.lastCheckpointCommit
memory checkpoint commit
```

Если `HEAD` изменился не через planner wrapper:

1. Normal flow останавливается.
2. Planner переходит в `recovery` или `discovery_update`, в зависимости от риска.
3. Если worktree clean и branch ожидаемая, destructive action не нужен.
4. Extension строит snapshot и запускает freshness analysis.
5. Если file hashes показывают изменения, модель обновляет memory только по affected files.
6. После successful memory update checkpoint переносится на actual `HEAD`.
7. Если branch/merge targets/worktree path не совпадают со state, остаёмся в recovery и просим user decision.

Внешний commit не является ошибкой сам по себе. Ошибка — продолжить старый stage, не обновив memory и не подтвердив state.

#### Если rebase переписал историю

Если `state.lastCheckpointCommit` больше не находится в истории:

1. Не делать reset автоматически.
2. Проверить memory checkpoint hashes.
3. Построить full snapshot.
4. Сравнить file hashes с `files/index.jsonl`.
5. Если memory files не повреждены, обновить только changed/new/missing files.
6. Если memory checkpoint повреждён или state противоречит git/worktree, перейти в recovery и спросить пользователя перед destructive repair.

### Rebase и повреждённое git-состояние

Когда git history меняется, extension не должен опираться только на commit ancestry.

Порядок решения:

1. Если expected commit является ancestor текущего commit, использовать git diff.
2. Если ancestry переписана, сравнить file hashes с `files/index.jsonl`.
3. Если memory checkpoint валиден, обновить только changed files.
4. Если memory checkpoint повреждён, перейти в recovery.
5. Если git и memory одновременно неопределённы, спросить пользователя перед destructive repair.

Важное правило:

```
Никогда не делать reset, delete или force checkout только потому, что memory stale.
Stale memory запускает discovery_update, а не destructive git repair.
```

---

## 7. Markdown Instructions Sync

Markdown instructions — это основной текстовый контракт для модели. `planner_status` должен возвращать exact instruction files и собранный markdown bundle для текущего `stage/step`, чтобы модель не пропускала обязательное чтение инструкций. Полные memory indexes в status не вставляются; они выдаются как paths и retrieval hints.

### Источники instructions

В repo extension лежат default markdown files. Они являются source of truth для новой версии extension.

При запуске или инициализации extension проверяет instruction files в PI extension dir:

```
getAgentDir()/extensions/pi-code-planner/instructions/
```

Схема:

```text
getAgentDir()/extensions/pi-code-planner/instructions/
  defaults/
    init.md
    discovery.md
    planning.md
    execution.md
    finalize.md
    done.md
    recovery.md
    tdd.md
    experiment.md
    refactor.md
    memory.md
    git.md
    git-commit.md

  append/
    init.md
    discovery.md
    planning.md
    execution.md
    finalize.md
    done.md
    recovery.md
    tdd.md
    experiment.md
    refactor.md
    memory.md
    git.md
    git-commit.md
```

Project-local append files работают как `.vscode` настройки проекта:

```text
<project-root>/.pi/pi-code-planner/instructions/append/
  init.md
  discovery.md
  planning.md
  execution.md
  finalize.md
  done.md
  recovery.md
  tdd.md
  experiment.md
  refactor.md
  memory.md
  git.md
  git-commit.md
```

Пользователь сам решает, создавать project-local append files или нет. Extension не создаёт их автоматически и не добавляет `.pi/pi-code-planner/instructions/append/` в `.gitignore`.

### Defaults and append

- `defaults/*.md` всегда принадлежат extension.
- Extension может перезаписывать `defaults/*.md` при update, если hash изменился.
- User не должен редактировать `defaults`.
- User правит только `append/*.md`.
- Global append находится в `getAgentDir()/extensions/pi-code-planner/instructions/append/`.
- Project append находится в `<project-root>/.pi/pi-code-planner/instructions/append/`.
- Project append заменяет global append для того же instruction file.
- Default instruction всегда читается первым. Append никогда не заменяет default, он только добавляется после default.
- На чтении делаем concat:

```text
defaults/discovery.md
+
selected append/discovery.md
```

Где `selected append/discovery.md` выбирается так:
- если project append существует, concat = default + project append
- если project append отсутствует, concat = default + global append
- если оба append отсутствуют, concat = default

Так мы сохраняем upgrade path и при этом даём user/project/company style override.

### Hash check

Для каждого default markdown file extension хранит hash. При запуске:

1. Посчитать hash default file из repo.
2. Посчитать hash installed file из PI extension dir `instructions/defaults/`.
3. Если installed file отсутствует — скопировать default.
4. Если hash совпадает — ничего не делать.
5. Если hash не совпадает — перезаписать installed default новым default.

Это нужно, чтобы extension мог обновлять системные инструкции после upgrade. User changes не теряются, потому что user правит `append/*.md`, а не `defaults/*.md`.

Правила:
- defaults всегда sync/update by hash
- append никогда не перезаписывается extension
- если append file отсутствует, он просто пропускается
- если append file пустой, он не меняет instruction
- `custom_instructions` не используется, потому что он ломает upgrade path

### `git-commit.md`

`git-commit.md` нужен отдельно от `git.md`.

`git.md` описывает planner-controlled git workflow: worktree, branch lifecycle, forbidden raw git, merge boundaries, recovery.

`git-commit.md` описывает только стиль сообщений:
- commit message style
- merge message style
- experiment checkpoint message style
- forbidden message patterns
- language/team conventions

Commit style не должен менять git flow. Он только формирует текст commit/merge messages, когда planner git tool уже решил, что commit или merge разрешён.

### Как модель использует markdown

Каждый stage/step/task/experiment получает список markdown artifacts через `planner_status`.

Модель обязана читать эти files перед действием:
- stage instruction
- task instruction
- TDD instruction
- verify instruction
- memory context
- пользовательские notes, если они есть

Markdown files могут быть пустыми в момент создания plan. Модель заполняет project/task-specific markdown на соответствующих steps. Default markdown files задают процесс и правила, а plan/task markdown files содержат конкретный контекст текущей работы.

Порядок concat для model prompt:

```text
default stage instruction
+ selected append for that instruction
+ current plan/task artifact
+ memory links from planner_status
```

`planner_status` возвращает ссылки на нужные markdown files и memory files, а также вставляет собранный markdown bundle только для текущего `stage/step`. Он не вставляет весь project memory целиком и не подменяет memory retrieval.
