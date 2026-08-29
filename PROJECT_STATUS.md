# csm 작업 현황 및 다음 할 일

> 작성일 2026-08-29 · v0.1.0 · GitHub 공개 레포 생성 완료, CI 초록불. **npm 배포 전**
> https://github.com/soohunee/claude-session-manager

---

## 1. 지금 어디까지 됐나

**코드는 완성됐고 동작 검증까지 끝났다.** 남은 건 배포(GitHub/npm)와 내 실제 환경에 `init` 적용뿐.

| 항목 | 상태 |
|---|---|
| CLI 전체 명령어 | 완료 |
| 인터랙티브 TUI 피커 | 완료 (pty로 실동작 검증) |
| 태그 + 아카이브 + 복원 | 완료 (왕복 검증) |
| `/persist` 슬래시 커맨드 | 완료 (파일 생성됨, 미설치) |
| 훅 자동 설치/제거 | 완료 (샌드박스 검증, 실환경 미적용) |
| 테스트 | 11개 전부 통과 |
| README / LICENSE / CI | 완료 |
| GitHub 레포 | 완료 (public, CI 8개 매트릭스 전부 통과) |
| npm publish | **미배포** |

의존성 0개, Node 코드 1,420줄, 패키지 16.5KB.

---

## 2. 만들어진 명령어 (`csm --help` 전문)

```
csm — claude-session-manager v0.1.0

Find and resume any Claude Code session, from any directory.

USAGE
  csm [query]                 Interactive picker over every session (default)
  csm ls [query]              Print sessions instead of opening the picker
  csm resume <id|query>       Resume directly, skipping the picker
  csm tag <tag...>            Tag the session in this directory and archive it
  csm untag <tag...>          Remove tags (omit tags to clear the session)
  csm tags                    List every tag with its session count
  csm archive                 Archive all tagged sessions now
  csm prune                   Delete archives of sessions that are no longer tagged
  csm init                    Install the /persist command and session hooks
  csm uninstall               Remove them again
  csm doctor                  Show what csm sees and whether it is wired up

OPTIONS
  -t, --tag <tag>             Only sessions carrying this tag (repeatable)
  -d, --dir [path]            Only sessions from this directory (default: cwd)
  -n, --limit <n>             Cap the number of sessions shown
  -a, --all                   Include expired sessions with no transcript left
      --json                  Machine-readable output
      --session <id>          Target this session id instead of the current one
      --no-archive            With `tag`: record the tag but don't archive
      --refresh               Ignore the metadata cache and re-read every file
  -h, --help                  Show this help
  -v, --version               Show version

EXAMPLES
  csm                         Browse everything, fuzzy-search, hit enter to resume
  csm -t billing              Just the sessions you tagged #billing
  csm resume billing          Resume the newest #billing-matching session
  csm ls --dir --json         Sessions for this directory as JSON

Inside Claude Code, /persist <tag> tags the running session.
```

`--` 뒤의 인자는 그대로 `claude`에 전달된다: `csm resume billing -- --model opus`

---

## 3. 파일 구조

```
claude-session-manager/
├── bin/csm.js              7줄   진입점
├── src/
│   ├── paths.js           29줄   ~/.claude 경로 해석, CLAUDE_CONFIG_DIR 지원
│   ├── format.js          65줄   한글 폭 계산, 컬럼 정렬, 상대시각, ANSI 색
│   ├── store.js           75줄   tags.json 원자적 읽기/쓰기
│   ├── archive.js         90줄   아카이브 복사 / 복원 / 삭제
│   ├── tui.js            154줄   raw mode 인터랙티브 피커
│   ├── install.js        161줄   훅 설치·제거, /persist 생성, 현재 세션 판별
│   ├── scan.js           254줄   트랜스크립트 파싱 + 인덱스 + mtime 캐시
│   └── cli.js            414줄   인자 파싱, 각 명령어, resume 스폰
├── test/csm.test.js      171줄   node:test, 11개
├── README.md                     오픈소스용 영문 문서
├── PROJECT_STATUS.md             이 문서
├── LICENSE                       MIT
└── .github/workflows/ci.yml      Ubuntu/macOS × Node 18/20/22/24
```

---

## 4. 검증한 것 (증거)

- **TUI 실동작**: `expect`로 pty 붙여서 구동 → `마크다운` 입력 → 2개로 필터링 → 방향키 이동 → esc 정상 종료. 한글 폭 계산되어 컬럼 안 깨짐.
- **아카이브 왕복**: 세션 태깅(1.3MB 아카이브) → live 트랜스크립트 강제 삭제(클코 cleanup 시뮬레이션) → 여전히 resumable로 표시 → 복원 후 144개 메시지 **바이트 단위 동일**.
- **settings.json 병합 안전성**: 기존 Stop/PreToolUse/PostToolUse 훅 전부 보존, 기존 SessionStart 항목 위치 유지, 두 번 실행해도 중복 없음, `uninstall` 시 원래 모양 복구. 테스트로 고정.
- **claude 바이너리 없을 때**: 크래시 대신 `cd <dir> && claude --resume <id>` 수동 명령 안내.
- **비 TTY(파이프)**: 피커 대신 일반 목록 출력.
- **성능**: 78세션 콜드 스캔 94ms. 이후 mtime+size 캐시로 거의 읽지 않음.

### 개발 중 발견해서 고친 버그
복원 직후 아카이브를 불필요하게 재복사하던 문제. mtime 비교 → **size 비교**로 변경. 트랜스크립트가 append-only라 크기가 같으면 내용도 같다는 근거를 주석으로 남김.

---

## 5. 나중에 헷갈릴 설계 결정 4개

**① 프로젝트 디렉토리 이름을 역디코딩하지 않는다.**
클코는 cwd의 모든 비영숫자를 `-`로 바꿔 디렉토리명을 만든다(`/Users/x/a_b.c` → `-Users-x-a-b-c`). 되돌릴 수 없는 손실 변환이라, cwd는 **항상 트랜스크립트 안의 `cwd` 필드**에서 읽는다. `encodeProjectPath`는 아카이브를 되돌려놓을 때 *쓰기* 용도로만 쓴다.

**② 훅을 `UserPromptSubmit`에도 건다.**
`SessionStart`만 걸면 같은 디렉토리에 세션 두 개가 떠 있을 때 나중에 시작한 쪽이 스탬프를 덮어쓴다. `UserPromptSubmit`은 `/persist` 처리 **직전**에 발동하므로 스탬프가 반드시 그 세션을 가리킨다. 훅이 없으면 mtime 폴백으로 동작하고, 그 경우 "matched by recency"라고 알려준다.

**③ 복원 시 mtime을 원본으로 되돌리지 않는다.**
6개월 된 mtime으로 복원하면 클코의 cleanup 스윕이 곧바로 다시 지운다. 새 타임스탬프가 보호막 역할을 한다.

**④ 훅 명령어에 `|| true`를 붙인다.**
`UserPromptSubmit` 훅이 0이 아닌 값으로 종료하면 사용자의 프롬프트가 차단될 수 있다. csm이 어떤 이유로 실패해도 클코 사용을 막아서는 안 된다.

---

## 6. 다음에 할 일

### A. 지금 바로

- [x] **GitHub 레포 생성** — public으로 생성 완료: https://github.com/soohunee/claude-session-manager
- [x] `package.json`에 `repository`, `bugs`, `homepage`, `author` 필드 추가
- [x] README를 오픈소스 관례에 맞게 재작성 (배지, 기능 목록, 명령어·옵션·단축키 표)
- [x] 커밋 메시지에서 `Co-Authored-By: Claude` / `Claude-Session:` 트레일러 제거 후 force push
- [ ] **내 실제 `~/.claude`에 `csm init` 적용** — 지금까지 샌드박스에서만 테스트했고 진짜 settings.json은 안 건드렸음. 적용하면 `/persist` 실사용 가능. 백업은 `settings.json.csm-backup`으로 자동 생성됨.

### B. 첫 릴리즈까지

- [x] CI 초록불 확인 (Ubuntu/macOS × Node 18/20/22/24, actions v5로 상향)
- [ ] npm 이름 선점 확인 후 `npm publish` (npm login 필요)
- [ ] README에 데모 GIF 추가 — 피커에서 검색하고 엔터 눌러 resume되는 10초 분량. `vhs`나 `asciinema`로 녹화. **이게 스타 수를 가장 크게 좌우함.**
- [ ] `v0.1.0` 태그 + GitHub Release

### C. 기능 백로그 (우선순위 순)

- [ ] **`csm search <text>`** — 제목이 아니라 대화 *내용* 전문 검색. 트랜스크립트를 이미 파싱하고 있어서 어렵지 않고, "그 얘기 어디서 했더라"에 직접 답하는 기능이라 가치가 큼.
- [ ] **TUI 미리보기 패널** — tab 키로 선택한 세션의 마지막 몇 메시지 표시. 제목만으로 구분 안 될 때 필요.
- [ ] **`SessionEnd` 훅으로 자동 아카이브** — 태그된 세션이 끝날 때마다 최신 상태로 갱신. 지금은 태그 시점 스냅샷이라 이후 대화가 아카이브에 안 들어감. **꽤 중요한 구멍.**
- [ ] **`csm rm <id>`** — 세션 영구 삭제 (트랜스크립트 + 아카이브 + 태그).
- [ ] **`--fork`** — 원본 보존하고 복제해서 이어가기 (`claude --resume --fork-session` 위임).
- [ ] **디렉토리별 그룹 뷰** — 디렉토리가 많아지면 평면 목록이 힘들어짐.
- [ ] **셸 자동완성** (bash/zsh) — 태그 이름 완성.
- [ ] **Windows 검증** — 경로 처리와 raw mode가 안 돌아볼 확률 높음. 안 되면 README에 명시.
- [ ] **`cleanupPeriodDays` 상향 제안** — `csm doctor`에서 안내만 하지 말고 `csm init`이 물어보고 설정해주기.

### D. 알려진 한계 / 리스크

- **클코 내부 포맷 의존.** `~/.claude/projects/*.jsonl`, `history.jsonl`, `ai-title` 레코드는 공개 API가 아니다. 클코 업데이트로 깨질 수 있음. 완화책: 파싱 실패를 조용히 넘기고 `csm doctor`가 이상을 드러내도록 이미 설계됨. 릴리즈 노트에 "tested against Claude Code 2.x" 명시 필요.
- **동일 디렉토리 다중 세션.** 훅 없이 mtime 폴백만 쓸 때 잘못된 세션에 태그될 수 있음. 이미 경고 문구는 출력됨.
- **아카이브 용량.** 세션 하나가 1MB를 넘기도 함. 많이 태그하면 커짐 → `csm prune`이 있지만 용량 경고를 `doctor`에 추가하면 좋음.
- **태그 시점 스냅샷 문제.** 위 C의 `SessionEnd` 훅으로 해결 예정.

---

## 7. 재개하는 법

```bash
cd ~/Desktop/develop/claude-session-manager
npm test                      # 11개 통과해야 정상
NO_COLOR=1 node bin/csm.js --help
node bin/csm.js doctor        # 읽기 전용, 안전

# 실환경 건드리지 않고 테스트하려면 (중요)
export CLAUDE_CONFIG_DIR=/tmp/csm-sandbox
```

`CLAUDE_CONFIG_DIR`만 바꾸면 진짜 `~/.claude`를 전혀 건드리지 않고 `init`/`tag`/`archive`까지 전부 실험할 수 있다. 파괴적인 명령을 시험할 땐 반드시 이걸 쓸 것.
