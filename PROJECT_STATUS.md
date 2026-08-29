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
csm — claude-sessions-cli v0.1.0

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
- [x] **실제 `~/.claude`에 `csm init` 적용 완료** — `npm link`로 `csm`을 PATH에 올린 뒤 적용했다. 기존 훅(Stop 3, PostToolUse 1, PreToolUse 4, SessionStart 2)이 전부 바이트 단위로 보존됐음을 확인했고, 백업은 `~/.claude/settings.json.csm-backup`에 있다. 훅은 새 세션부터 적용되므로 이번 세션은 아직 `via mtime`으로 뜬다. 주의: 훅이 이 저장소의 절대 경로를 가리키므로 저장소를 옮기면 훅이 죽는다(그 경우 `csm doctor`가 알려준다).

### B. 첫 릴리즈까지

- [x] CI 초록불 확인 (Ubuntu/macOS × Node 18/20/22/24, actions v5로 상향)
- [ ] npm 이름 선점 확인 후 `npm publish` (npm login 필요)
- [ ] README에 데모 GIF 추가 — 피커에서 검색하고 엔터 눌러 resume되는 10초 분량. `vhs`나 `asciinema`로 녹화. **이게 스타 수를 가장 크게 좌우함.**
- [ ] `v0.1.0` 태그 + GitHub Release

### C. 기능 백로그 (우선순위 순)

- [x] **`csm search <text>`** — 대화 내용 전문 검색. 원본 JSONL을 먼저 문자열로 훑어 걸러내고, 적중한 파일에서만 해당 줄을 파싱한다. 29개 세션(5.8MB 파일 포함) 전체 검색이 104ms. 다만 JSON 인코딩이 바꿔 놓는 문자(따옴표·백슬래시·개행)가 검색어에 있으면 이 빠른 경로를 건너뛰고 줄 단위로 파싱한다. 조사한 어느 경쟁 도구도 이 기능은 없다.
- [x] **TUI 미리보기 패널** — tab 키로 토글. 구현하면서 알게 된 점: 에이전트 세션은 `tool_use`/`tool_result` 레코드가 수십 KB씩 차지해서, 단순히 파일 끝 96KB만 읽으면 사용자 프롬프트가 한 개도 안 잡힌다. 그래서 사용자 발화가 2개 이상 들어올 때까지 창을 4배씩 넓히고, 마지막 사용자 발화가 화면에 반드시 포함되도록 슬라이스 시작점을 앞으로 당긴다. 29개 세션 평균 1.2ms, 5.8MB 파일 최악 7ms.
- [x] **`SessionEnd` 훅으로 자동 아카이브** — 태그된 세션이 끝날 때마다 아카이브를 갱신한다. 태그 안 된 세션은 건드리지 않는다. 작업하면서 **기존 훅 명령어의 `|| true` 가드가 죽어 있던 것을 발견해 함께 고쳤다**: `#` 주석 뒤에 있어서 셸이 통째로 무시하고 있었고, 설계 결정 ④가 의도한 보호가 전혀 작동하지 않는 상태였다. `csm init`은 이제 구버전이 남긴 훅을 중복 추가 없이 제자리에서 교체한다.
- [ ] **`csm rm <id>`** — 세션 영구 삭제 (트랜스크립트 + 아카이브 + 태그).
- [x] **`--fork`** — `claude --resume --fork-session`에 위임. 피커에서는 `^f`.
- [x] **정렬 전환** — `--sort time|title|dir`, 피커에서는 `^t`/`^o`/`^g`. 디렉토리 정렬이 아래의 "디렉토리별 그룹 뷰"를 상당 부분 대신한다.
- [x] **Remote Control 핸드오프** — `--remote`, 피커에서는 `^r`. `claude --remote-control`에 위임.
- [x] **`--print-cmd`** — 실행 대신 명령어만 출력. 피커에서는 `^y`. 아카이브 복원은 먼저 수행하므로 출력된 명령어가 나중에 실행해도 동작한다.
- [ ] **디렉토리별 그룹 뷰** — `--sort dir`로 대부분 해결됐으나, 디렉토리 헤더를 실제로 끼워 넣는 것은 남아 있음. 우선순위 낮음.
- [ ] **셸 자동완성** (bash/zsh) — 태그 이름 완성.
- [ ] **Windows 검증** — 경로 처리와 raw mode가 안 돌아볼 확률 높음. 안 되면 README에 명시.
- [ ] **`cleanupPeriodDays` 상향 제안** — `csm doctor`에서 안내만 하지 말고 `csm init`이 물어보고 설정해주기.

### D. 알려진 한계 / 리스크

- **클코 내부 포맷 의존.** `~/.claude/projects/*.jsonl`, `history.jsonl`, `ai-title` 레코드는 공개 API가 아니다. 클코 업데이트로 깨질 수 있음. 완화책: 파싱 실패를 조용히 넘기고 `csm doctor`가 이상을 드러내도록 이미 설계됨. 릴리즈 노트에 "tested against Claude Code 2.x" 명시 필요.
- **동일 디렉토리 다중 세션.** 훅 없이 mtime 폴백만 쓸 때 잘못된 세션에 태그될 수 있음. 이미 경고 문구는 출력됨.
- **아카이브 용량.** 세션 하나가 1MB를 넘기도 함. 많이 태그하면 커짐 → `csm prune`이 있지만 용량 경고를 `doctor`에 추가하면 좋음.
- ~~**태그 시점 스냅샷 문제.**~~ `SessionEnd` 훅으로 해결됨.

---

## 6-1. 경쟁 조사 (2026-08-29)

npm에서 `claude-session-manager`가 이미 선점되어 있어 조사한 결과, **패키지명은 `claude-sessions-cli`로 변경**했다. GitHub 레포명과 `csm` 명령어는 그대로다.

이름만 비슷하고 하는 일이 다른 것들(별 개수가 큰 쪽이 대부분 여기 속함):

| 프로젝트 | 별/포크 | 실제로 하는 일 |
|---|---|---|
| iannuttall/claude-sessions | 1209 / 137 | 개발 기록용 슬래시 커맨드 모음 |
| terryso/claude-auto-resume | 816 / 67 | 사용량 한도 해제 시 자동 재개하는 셸 스크립트 |
| craftzdog/tmux-claude-session-manager | 371 / 48 | 실행 중인 세션을 tmux 창으로 배치 |
| MedivhStory/ClaudeSessionHub | 105 / 5 | macOS 네이티브 GUI |
| dlupiak/claude-session-dashboard | 65 / 13 | 세션 관측 대시보드 |

**정말로 겹치는 것 둘:**

- **kylinfish/claude-code-resume (`ccr`, 별 12)** — 전 프로젝트 스캔, 퍼지 피커, 변경분만 다시 읽는 인덱스 캐시, CJK 폭 정렬, `cd` 후 `claude --resume`까지 csm의 피커와 사실상 같다. Bash 스크립트 한 개이며 **아카이빙은 하지 않는다.** 여기서 미리보기 패널, 정렬 전환, Remote Control 핸드오프, 명령어 출력 기능을 벤치마킹해 구현했다.
- **ihoooohi/claude-code-session-cleaner (`ccsc`, 별 102)** — 방향이 반대다. 세션을 *안전하게 지우는* 도구이고 복구 가능한 휴지통을 둔다. 메커니즘은 아카이브와 닮았지만 목적이 사용자가 직접 지운 것을 되살리는 데 있지, 클코가 30일마다 자동으로 쓸어가는 것을 막는 데 있지 않다.

**결론: csm의 고유 영역은 태그 → `cleanupPeriodDays` 밖으로 아카이브 → 재개 시 제자리 복원이다.** 조사한 어느 프로젝트도 이걸 하지 않는다. "디렉토리 넘나들며 찾아 재개한다"는 절반은 ccr이 이미 잘 해냈으므로, README 포지셔닝을 아카이빙 쪽으로 옮기는 것을 검토할 것.

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
