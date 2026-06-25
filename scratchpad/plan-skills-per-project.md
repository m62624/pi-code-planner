# План: per-project скиллы + вложение plans в projects + агрессивный capture

Ветка от `main` (имеет всё новое, без fetch). Доставка: по коммиту на задачу,
без PR/push/bump — пользователь мержит сам. Имя ветки: `refactor/per-project-storage`.

Решения пользователя (зафиксированы):
1. Скиллы → `projects/<projectId>/skills/`; bundled (elenchus) остаётся глобальным.
2. Планы → `projects/<projectId>/plans/<planId>` + миграция существующих.
3. Capture — **только усиление инструкции** (без нового sourceKind, без детектора
   повторов): no-skill становится «дорогим», дефолт — создать/обновить скилл при
   любой повторяемой форме (включая переиспользуемые код-паттерны/болерплейт).

---

## Контекст (факты из кода — почему так)

- `createProjectStoragePaths` (`paths.ts:45`): `extensionDir = agentDir/extensions/pi-code-planner`.
  - `projectDir = extensionDir/projects/<projectId>` — сейчас только `project.json`.
  - `plansDir = extensionDir/plans` (**плоско**, все планы всех проектов вперемешку).
- `createPlanStoragePaths(projectPaths, planId)` (`paths.ts:68`) кладёт план в
  `projectPaths.plansDir/<planId>` — **единственная** точка деривации пути плана.
- `createPlannerSkillStoragePaths(projectPaths)` (`skill-library.ts:90`) кладёт скиллы в
  `projectPaths.extensionDir/skills/{library,index.json}` — **глобально**, единственная точка.
- `createProjectId(root)` = `<имя>-<sha256_8>` (`ids.ts:7`); `resolveProjectStoragePaths`
  (`project-resolver.ts`) маппит worktree любого плана обратно на исходный projectRoot →
  стабильный projectId из всех планов. Якорь для «скилл на проект, шарится между планами».
- `ProjectRecord` (`schema.ts:187`) уже хранит `plans[]` + `activePlanId` → авторитетный
  список планов проекта (нужен для миграции). `PlanRecord` свой projectId НЕ хранит.
- Bundled elenchus: `extensionDir/skills/bundled/elenchus/SKILL.md` (`elenchus-skill.ts:14`),
  версионируется `.engine-version`, имя `pi-planner-elenchus`, не в индексе, не под maxActive.
  Discovery (`index.ts:1470` → `skill-library.ts:261-277`) префиксит его перед юзер-скиллами.
  На resume выводится (worktree-сессия → isPlanActive()=true). **Уже работает** — добавим тест.
- Шаг `capture_skill` (`status.ts:502`): единственная точка, конец каждой задачи; инструкция
  разрешает уйти, записав no-skill заметку → модель почти всегда так и делает.

Радиус правок узкий: смена базы в `paths.ts` и `skill-library.ts` автоматически
перенаправляет всех читателей (они идут через эти две функции).

---

## Задача 1 — вложить plans в projects/<projectId>/ (коммит `refactor(storage): nest plans under project dir`)

### Код
- `paths.ts`:
  - `plansDir: join(extensionDir, "plans")` → `join(projectDir, "plans")` (строка 62).
  - `createPlansDirectory` (97) → `join(projectPaths.projectDir, "plans")` (или вернуть
    `projectPaths.plansDir`, чтобы был один источник истины).
  - Остальное (`createPlanStoragePaths`) не трогаем — оно уже через `projectPaths.plansDir`.
- Проверить читателей плоского скана: `project-store.ts:47 mkdirp(plansDir)` — ок, теперь
  создаёт вложенную папку. Глобального скана `plans/` без projectPaths в коде нет (проверено
  grep) — все идут через `resolveProjectStoragePaths(cwd) → projectPaths`.

### Миграция (идемпотентная, безопасная, best-effort)
- Новый модуль `storage/migrate-layout.ts`: `migratePlansIntoProjects({fs, agentDir})`.
  - Для каждого `projects/<projectId>/project.json`: для каждого planId из
    `record.plans[]` ∪ `activePlanId`: если `extensionDir/plans/<planId>` существует и
    `projectDir/plans/<planId>` ещё нет → `fs.move` (или copy+removeDir) внутрь проекта.
  - Если целевой уже есть — пропуск (идемпотентность). Никогда не удаляем источник, если
    переезд не подтверждён.
  - Осиротевшие планы (нет в project.json) — НЕ трогаем, оставляем в `extensionDir/plans/`.
- Вызов: один раз на `session_start` (рядом с `registerInstructionDefaultsSync`,
  `index.ts:1486`), обёрнут в try/catch — миграция никогда не блокирует старт.
- worktree-index при этом не меняется (хранит projectRoot/worktreePath, не путь плана).

### Тесты
- `paths.test`/`storage.test`: ожидаемый путь плана теперь `projects/<id>/plans/<planId>`.
- Новый `migrate-layout.test.ts`: плоский план → переезжает; повторный вызов — no-op;
  осиротевший план не трогается; коллизия (цель есть) — источник не теряется.
- Прогнать существующие plan/active-plan/accepted-plan тесты — поправить ожидаемые пути.

---

## Задача 2 — per-project пул скиллов (коммит `refactor(skills): scope the skill pool to the project`)

### Код
- `skill-library.ts:90` `createPlannerSkillStoragePaths`:
  `skillsDir = join(projectPaths.extensionDir, "skills")` →
  `join(projectPaths.projectDir, "skills")`. `library/`, `index.json` — относительно него.
- Bundled elenchus (`elenchus-skill.ts`) НЕ трогаем — остаётся глобальным
  `extensionDir/skills/bundled/`. Discovery уже префиксит его поверх (теперь уже
  per-project) юзер-скиллов — порядок сохраняется.
- `listPlannerSkillResourcePaths` / `listActivePlannerSkill*` — без изменений: они берут
  `projectPaths` и зовут `createPlannerSkillStoragePaths`, путь переедет автоматически.

### Миграция глобального пула (edge, вероятно пустой)
- В `migrate-layout.ts` добавить `migrateGlobalSkills`: если `extensionDir/skills/index.json`
  существует и непустой — поведение по умолчанию: **оставить как глобальный read-only
  fallback** (discovery дочитывает его и мержит, помечая как legacy), новые записи идут
  per-project. Не атрибутируем старые скиллы к проекту (нельзя достоверно). Если пуст —
  ничего не делаем. (Пользователь говорил «ни разу скилл не создал» → ожидаем пусто.)
- Альтернатива на согласование: просто игнорировать старый глобальный пул. Реализуем
  fallback-чтение как наименее разрушительное.

### Тесты
- `skill-library.test.ts`: путь скилла теперь `projects/<id>/skills/library/...`; два разных
  projectId → независимые индексы (создание в A не видно из B).
- Тест на bundled-fallback порядок: discovery всё ещё `[elenchus, ...userSkills(project)]`.

---

## Задача 3 — агрессивный capture через инструкцию (коммит `feat(skills): make capture default-on, no-skill expensive`)

Только текстовые/правило-изменения, без новых тулов/видов.

- `status.ts:502` `capture_skill` stepRule:
  - `objective`: «Зафиксируй переиспользуемый паттерн (включая повторяющуюся форму кода:
    трейты/болерплейт/структуры ошибок/билдеры) как скилл; no-skill — исключение».
  - `requiredActions`: дефолт — create/update. no-skill теперь требует **конкретного**
    обоснования в decisions.md: почему ничто из сделанного не повторится и не переиспользуемо
    (общая фраза не принимается — назвать рассмотренные кандидаты-паттерны и причину отказа).
  - `exitCondition`: «скилл создан/обновлён, ИЛИ в decisions.md есть явное обоснование
    no-skill с перечислением отвергнутых кандидатов».
- `status.ts:62` (общий гайд) и `:425`/`:472`: расширить формулировку «verified reusable
  lesson» — явно включить рекуррентные код-структуры/болерплейт как валидный, ценный
  контент скилла (сниппет + когда применять в body); сместить дефолт к захвату.
- Тело скилла уже свободный markdown (валидатор требует лишь H1 + нет frontmatter) — формат
  кода-сниппета помещается без изменений в schema/валидатор.

### Тесты
- `status` snapshot/текстовые тесты — обновить под новые строки capture_skill.
- (Опц.) тест-проверка, что инструкция capture_skill содержит требование явного no-skill
  обоснования и упоминание код-паттернов.

---

## Задача 4 — регресс elenchus-on-resume (коммит `test(skills): assert bundled elenchus survives resume`)

- Юнит на `listPlannerSkillResourcePaths`: при `plannerActive:true` и непустом per-project
  пуле результат = `[bundledElenchusPath, ...projectUserSkills]`; при `plannerActive:false` → [].
  Зафиксировать, что переезд скиллов в projectDir не сломал префикс bundled.

---

## Верификация
- `npx tsc --noEmit`, `npm run build`, `npx vitest run` — всё зелёное.
- biome чисто.
- Ручная проверка (после согласования): создать план в проекте A → план лежит в
  `projects/<A>/plans/<id>`; скилл создаётся в `projects/<A>/skills`; в проекте B его нет;
  resume A → elenchus + скиллы A в discovery; старые плоские планы переехали, повторный
  старт — no-op.

## Открытые мелочи (подтвердить при старте)
- Глобальный старый пул скиллов: fallback-read (выбрано) vs игнор.
- Имя ветки `refactor/per-project-storage` ок?
