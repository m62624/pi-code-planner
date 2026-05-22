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

## 2. Stages: INIT → Discovery → Planning → Execution

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

### Execution
Каждый task проходит через подстадии:

1. Task branch создаётся
2. Experiments: несколько веток с разными подходами
3. Agent выбирает лучший experiment
4. Best experiment merge → task branch
5. Refactor: улучшение кода без изменения поведения
6. Task branch merge → plan branch

Каждая подстадия = compact перед следующей.

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
- Default path: `<project-root>/.pi/worktrees/<plan-id>`
- User может выбрать другой worktree root при создании плана

#### `git worktree remove <path>`
- Удаляет worktree после завершения плана
- Вызывается после merge plan в оригинальную папку

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
- Удаляет experiment ветку после выбора кандидата
- Удаляет task ветку после merge в plan
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

Внутри extension storage состояние хранится отдельно для каждого открытого проекта. Нельзя хранить один глобальный `state.json` на все проекты: это ломает восстановление, путает активные планы и делает восстановление после crash неоднозначным.

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
  state.json
  plans/
    <plan-id>/
      plan.json
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
              diff.md
```

Plan worktree хранится отдельно от state. Его расположение настраивается.

По умолчанию:

```
<project-root>/.pi/worktrees/<plan-id>/
```

Альтернатива:

```
getAgentDir()/extensions/pi-code-planner/projects/<project-id>/worktrees/<plan-id>/
```

Пользовательский путь:

```
<user-selected-root>/<project-id>/<plan-id>/
```

Правила:
- один plan создаёт ровно один worktree
- task, experiment и refactor являются git-ветками внутри этого worktree
- расположение worktree выбирается при создании plan
- если используется project-local worktree, extension автоматически добавляет `.pi/worktrees/` в `.gitignore`
- extension не должен автоматически игнорировать всю `.pi/`, потому что пользователь может хранить там полезные project-local настройки
- если `.pi/worktrees/` уже покрыт существующим `.gitignore`, extension не дублирует правило

### `project.json`

`project.json` — постоянная карточка проекта. Она отвечает на вопрос: какой это project и какие планы с ним связаны.

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
      "status": "active",
      "createdAt": "2026-05-22T10:00:00.000Z"
    }
  ]
}
```

Правила:
- `plans` хранит только summary всех планов проекта
- подробности плана лежат в `plans/<plan-id>/plan.json`
- `createdAt` нужен для списка и сортировки планов
- `lastOpenedAt` не используется в v3, потому что не помогает модели и создаёт лишние записи

### `state.json`

`state.json` — восстанавливаемое после crash состояние выполнения planner в этом проекте. Он отвечает на вопрос: что planner делает сейчас и какой следующий step должен быть выполнен.

Главная идея: завершённый step нельзя повторять автоматически. Если компьютер выключился после завершения step, extension читает `nextStep` и продолжает с него.

Пример:

```json
{
  "schemaVersion": 1,
  "activePlanId": "plan-fix-find-command",
  "stage": "discovery",
  "step": "read_project",
  "stepStatus": "completed",
  "nextStep": "write_memory",
  "activeTaskId": null,
  "activeExperimentId": null,
  "worktreePath": "/home/m62624/Projects/main/pi-approval-modes/.pi/worktrees/plan-fix-find-command",
  "branches": {
    "base": "main",
    "plan": "plan/plan-fix-find-command",
    "currentTask": null,
    "currentExperiment": null,
    "selectedExperiment": null
  },
  "currentBranch": "plan/plan-fix-find-command",
  "mergeTargets": {
    "experimentToTask": null,
    "taskToPlan": null,
    "planToOutput": null
  },
  "lastCheckpointCommit": null,
  "requiresCompact": false,
  "requiresUserDecision": false,
  "blockedReason": null
}
```

Правила:
- `state.json` часто обновляется
- state всегда привязан к конкретному project
- `stage` — крупная стадия: например `init`, `discovery`, `planning`, `execution`, `recovery`, `done`
- `step` — конкретный подшаг внутри stage
- `stepStatus` — состояние подшага: `pending`, `running`, `completed`, `failed`, `blocked`
- `nextStep` показывает следующий допустимый step после завершения текущего
- `branches` хранит реальные имена веток, чтобы модель не решала сама куда merge делать
- `mergeTargets` хранит ожидаемые merge пары для текущего этапа
- после restart extension сначала читает `state.json`, затем проверяет git/worktree, затем либо продолжает с `nextStep`, либо переходит в recovery
- если state противоречит реальному git/worktree состоянию, planner переходит в recovery stage
- extension не должен повторять `completed` step без явного recovery/user decision

Модель не выбирает merge target. Например, при `select_experiment` модель выбирает только `experimentId`, а extension берёт target из `state.json`:

```
selected experiment branch -> current task branch
current task branch -> plan branch
plan branch -> output branch
```

### `plans/<plan-id>/plan.json`

`plan.json` — machine-readable состояние конкретного плана.

Пример:

```json
{
  "schemaVersion": 1,
  "planId": "plan-fix-find-command",
  "title": "Fix approval-modes false positive",
  "status": "active",
  "stage": "planning",
  "baseBranch": "main",
  "planBranch": "plan/plan-fix-find-command",
  "worktreePath": "/home/m62624/Projects/main/pi-approval-modes/.pi/worktrees/plan-fix-find-command",
  "tasks": []
}
```

Правила:
- `project.json` знает только краткое описание плана
- `state.json` знает активное execution состояние
- `plan.json` знает структуру и progress конкретного плана
- markdown-файлы рядом с `plan.json` являются читаемым контекстом для модели, но не заменяют JSON state

---

## 5. Машина стадий

Модель всегда должна вызывать status/next-step tool, если не уверена что делать дальше. Tool читает `state.json`, проверяет git/worktree и возвращает единственный допустимый следующий шаг. Модель не должна сама перескакивать stage или выполнять raw git.

### Stage 1: `init`

Цель: подготовить project storage, git и plan worktree.

Подшаги:

1. `check_project` — определить root открытого проекта и project id.
2. `check_git` — проверить, есть ли git repo; если нет, planner предлагает/выполняет git init через controlled tool.
3. `prepare_storage` — создать или загрузить `project.json`, `state.json`, директории проекта.
4. `choose_worktree_location` — выбрать расположение для plan worktree: project-local, agent-dir или custom.
5. `create_plan_record` — создать `plan.json`, `plan.md`, базовые artifacts и краткое описание в `project.json`.
6. `create_plan_worktree` — создать один git worktree для всего plan.
7. `enter_discovery` — обновить `state.json`: `stage=discovery`, `step=read_project`.

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
9. `enter_planning` — обновить `state.json`: `stage=planning`, `step=read_memory`.

### Stage 3: `planning`

Цель: построить исполнимый план на основе discovery и memory.

Подшаги:

1. `read_memory` — прочитать compact + memory blob, а не весь проект заново.
2. `draft_plan` — записать общий план в `plan.md`.
3. `split_tasks` — разбить работу на atomic tasks.
4. `write_task_files` — создать `tasks/<task-id>/task.json` и `task.md` для каждого task.
5. `verify_plan` — проверить, что tasks атомарные, упорядоченные и имеют чёткие acceptance criteria.
6. `compact_planning` — выполнить compact boundary после planning.
7. `enter_execution` — обновить `state.json`: `stage=execution`, `step=prepare_task`.

### Stage 4: `execution`

Цель: выполнить каждый task через TDD, эксперименты, выбор кандидата, refactor и merge в plan branch.

Подшаги для каждого task:

1. `prepare_task` — выбрать следующий task, создать или переключить task branch, загрузить task artifacts.
2. `write_tdd_plan` — записать TDD план до любых production edits.
3. `write_tests` — написать failing/mock/contract tests до production code.
4. `run_failing_tests` — подтвердить, что тесты действительно проверяют требование и падают/ловят отсутствие реализации.
5. `start_experiments` — создать список попыток эксперимента и первый experiment branch.
6. `run_experiment` — реализовать один подход в experiment branch.
7. `summarize_experiment` — записать summary, diff и результат проверки experiment.
8. `compact_experiment` — выполнить compact boundary перед следующим experiment или selection.
9. `select_experiment` — модель выбирает лучший `experimentId`; merge target берётся из `state.json`.
10. `merge_best_experiment` — extension merge выбранный experiment branch в current task branch.
11. `refactor_task` — улучшить код на task branch без изменения поведения.
12. `run_final_tests` — прогнать финальные проверки task branch.
13. `merge_task_to_plan` — extension merge current task branch в plan branch.
14. `compact_task` — выполнить compact boundary после завершения task.
15. `select_next_task` — выбрать следующий task или перейти в finalize.

### Stage 5: `finalize`

Цель: подготовить один чистый результат для user.

Подшаги:

1. `verify_plan_branch` — проверить, что plan branch содержит все merged tasks и проходит финальные проверки.
2. `prepare_output_branch` — создать или обновить output branch в исходном repo проекта.
3. `merge_or_export_result` — перенести итог plan branch из worktree в output branch.
4. `cleanup_worktree` — удалить plan worktree и временные managed branches, которые безопасно удалять.
5. `mark_done` — обновить `project.json`, `plan.json`, `state.json`: plan завершён, active execution отсутствует.

### Stage 6: `recovery`

Цель: восстановить planner после crash, ручных git изменений или несовпадения state с реальностью.

Подшаги:

1. `read_state` — прочитать `project.json`, `state.json`, активный `plan.json`.
2. `inspect_git` — проверить repo, worktree, current branch, commits, dirty/conflict state.
3. `compare_expected_actual` — сравнить реальное git-состояние с `state.json`: expected branch, worktree path, checkpoint commit, merge targets.
4. `classify_recovery` — определить тип проблемы: missing worktree, wrong branch, dirty checkpoint, external commit, conflict, missing plan files.
5. `ask_user_if_destructive` — если repair требует удаления, reset или force operation, спросить пользователя; модель не принимает destructive решение сама.
6. `repair_or_resume` — выполнить безопасное восстановление или вернуться к stage/step/nextStep из `state.json`.

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

Для MVP достаточно одного `symbols/index.jsonl`. Sharding можно добавить позже как внутреннюю оптимизацию, если файл станет слишком большим.

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
