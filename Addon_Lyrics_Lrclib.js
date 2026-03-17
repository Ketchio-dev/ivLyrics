/**
 * ================================================================================
 * LRCLIB Lyrics Provider Addon
 * ================================================================================
 * 
 * 이 파일은 LRCLIB(https://lrclib.net) 오픈소스 가사 데이터베이스에서 
 * 가사를 검색하고 가져오는 Spicetify 애드온입니다.
 * 
 * 【주요 기능】
 * - 제목 + 가수 구조화 검색만 사용
 * - 재생 시간(Duration) ±3초 이내 결과만 채택
 * - Jaro-Winkler 알고리즘 기반 문자열 유사도 매칭
 * - 싱크 가사(LRC 형식) 및 일반 텍스트 가사 지원
 * - 네트워크 오류 시 자동 재시도 메커니즘
 * 
 * 【검색 전략】
 * - track_name + artist_name 파라미터 사용
 * - duration은 클라이언트에서 ±3초로 엄격 검증
 * - 제목/가수 자유검색 폴백 없음
 *
 * @addon-type lyrics        - 가사 제공자 타입의 애드온
 * @id lrclib               - 고유 식별자
 * @name LRCLIB             - 표시 이름
 * @version 1.0.0           - 버전 정보
 * @author ivLis STUDIO     - 제작자
 * @supports karaoke: false - 노래방 모드 미지원 (커뮤니티 sync-data 확장으로 지원 가능)
 * @supports synced: true   - 시간 동기화된 가사 지원
 * @supports unsynced: true - 시간 동기화 없는 일반 가사 지원
 */

// ================================================================================
// IIFE (Immediately Invoked Function Expression) 패턴
// ================================================================================
// 전역 스코프 오염을 방지하고, 모든 변수와 함수를 캡슐화합니다.
// 애드온 로드 시 즉시 실행되어 LyricsAddonManager에 자신을 등록합니다.
(() => {
    'use strict';  // 엄격 모드 활성화: 잠재적 오류를 사전에 방지

    // ============================================
    // Addon Metadata (애드온 메타데이터)
    // ============================================
    // LyricsAddonManager가 이 애드온을 식별하고 관리하는 데 사용하는 정보입니다.
    // UI에 표시되는 이름, 설명, 아이콘 등이 포함됩니다.

    const ADDON_INFO = {
        id: 'lrclib',           // 【고유 ID】 다른 애드온과 구분하기 위한 식별자
        name: 'LRCLIB',         // 【표시 이름】 UI에 표시되는 애드온 이름
        author: 'ivLis STUDIO', // 【제작자】 애드온 개발자 정보
        version: '1.0.0',       // 【버전】 시맨틱 버저닝 (Major.Minor.Patch)
        cacheVersion: '2026-03-18-primary-artist-fallback',

        // 【다국어 설명】 사용자 언어 설정에 따라 표시
        description: {
            en: 'Get lyrics from LRCLIB open-source lyrics database',
            ko: 'LRCLIB 오픈소스 가사 데이터베이스에서 가사를 가져옵니다'
        },

        // 【지원 가사 유형】 이 애드온이 제공할 수 있는 가사 형식
        supports: {
            karaoke: false,   // 노래방 모드 (단어별 하이라이트) - 현재 미지원
            synced: true,     // 싱크 가사 (타임스탬프 포함 LRC 형식) - 지원
            unsynced: true    // 일반 가사 (텍스트만) - 지원
        },

        // 【ivLyrics Sync 통합】 true면 커뮤니티 싱크 데이터 자동 적용
        useIvLyricsSync: true,

        // 【아이콘】 SVG path 데이터 - LRC 파일을 나타내는 문서 아이콘
        icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM8 12h8v2H8v-2zm0 4h8v2H8v-2zm0-8h3v2H8V8z'
    };

    // ============================================
    // API Endpoints (API 엔드포인트)
    // ============================================
    // LRCLIB 서버의 기본 API 주소입니다.
    // 모든 API 요청은 이 주소를 기반으로 구성됩니다.
    // 
    // 【사용 가능한 엔드포인트】
    // - GET /api/search?track_name=...&artist_name=... : 구조화된 검색
    // - GET /api/search?q=... : 자유 텍스트 검색
    // - GET /api/get?...      : 특정 가사 직접 조회

    const LRCLIB_API_BASE = 'https://lrclib.net/api';
    const LRCLIB_DURATION_TOLERANCE_SEC = 3;
    const LRCLIB_MIN_TITLE_SCORE = 0.72;
    const LRCLIB_MIN_ARTIST_SCORE = 0.55;

    // ============================================
    // Helper Functions (헬퍼 함수)
    // ============================================
    // 가사 검색 및 매칭에 필요한 유틸리티 함수들입니다.
    // 문자열 정규화, 유사도 계산, 네트워크 요청, 가사 파싱 등을 담당합니다.

    /**
     * ────────────────────────────────────────────────────────────────────────────
     * 문자열 정규화 함수 (normalize)
     * ────────────────────────────────────────────────────────────────────────────
     * 
     * 【목적】
     * 서로 다른 형식의 문자열을 비교하기 위해 통일된 형태로 변환합니다.
     * 예: "Hello  World" vs "hello world" → 동일하게 처리
     * 
     * 【정규화 단계】
     * 1. NFKC 유니코드 정규화 - 호환 문자를 표준 형태로 통일
     *    예: ＡＢＣ(전각) → ABC(반각), ｶﾅ(반각) → カナ(전각)
     * 2. 소문자 변환 - 대소문자 구분 제거
     * 3. 양끝 공백 제거 (trim)
     * 4. 스마트 따옴표를 일반 따옴표로 변환
     *    예: '' "" → ' "
     * 5. 모든 종류의 괄호 제거 - 부가 정보(feat., remix 등) 무시
     * 6. 연속 공백을 단일 공백으로 치환
     * 
     * @param {string} s - 정규화할 원본 문자열
     * @returns {string} 정규화된 문자열 (비어있으면 빈 문자열 반환)
     */
    function normalize(s) {
        if (!s) return '';  // null/undefined 처리
        return s.normalize('NFKC')       // 유니코드 NFKC 정규화
            .toLowerCase()               // 소문자 변환
            .trim()                      // 앞뒤 공백 제거
            .replace(/[\u2018\u2019]/g, "'")   // ''(스마트 작은따옴표) → '
            .replace(/[\u201c\u201d]/g, '"')   // ""(스마트 큰따옴표) → "
            .replace(/[()[\]{}]/g, '')   // 모든 괄호류 제거: () [] {}
            .replace(/\s+/g, ' ');       // 연속 공백 → 단일 공백
    }

    /**
     * ────────────────────────────────────────────────────────────────────────────
     * Jaro-Winkler 유사도 계산 함수
     * ────────────────────────────────────────────────────────────────────────────
     * 
     * 【알고리즘 개요】
     * Jaro-Winkler는 두 문자열 간의 유사도를 0.0 ~ 1.0 사이 값으로 반환합니다.
     * 특히 짧은 문자열이나 오타 검출에 효과적이며, 제목/아티스트 매칭에 적합합니다.
     * 
     * 【계산 과정】
     * 1단계: Jaro 유사도 (dj) 계산
     *   - 일치 윈도우 = max(len1, len2) / 2 - 1
     *   - 윈도우 내에서 일치하는 문자 수 계산
     *   - 순서가 다른 일치(transposition) 계산
     *   - dj = (m/l1 + m/l2 + (m-t)/m) / 3
     * 
     * 2단계: Winkler 보정
     *   - 공통 접두사(최대 4자)에 가중치 부여
     *   - 최종 점수 = dj + prefix * 0.1 * (1 - dj)
     * 
     * 【예시】
     * - "MARTHA" vs "MARHTA" → 약 0.96 (철자 오류에도 높은 유사도)
     * - "DWAYNE" vs "DUANE" → 약 0.84
     * - "ABC" vs "XYZ" → 0.0 (완전 불일치)
     * 
     * @param {string} s1 - 비교할 첫 번째 문자열
     * @param {string} s2 - 비교할 두 번째 문자열
     * @returns {number} 유사도 점수 (0.0 = 완전 불일치, 1.0 = 완전 일치)
     */
    function jaroWinkler(s1, s2) {
        // 먼저 두 문자열을 정규화하여 공정한 비교 수행
        s1 = normalize(s1);
        s2 = normalize(s2);

        // Edge case 처리
        if (!s1 || !s2) return 0;  // 빈 문자열은 유사도 0
        if (s1 === s2) return 1;   // 완전 일치는 유사도 1

        const l1 = s1.length;  // 첫 번째 문자열 길이
        const l2 = s2.length;  // 두 번째 문자열 길이

        // 【일치 윈도우 계산】
        // 두 문자가 "일치"로 간주되려면 위치 차이가 윈도우 이내여야 함
        const matchWindow = Math.floor(Math.max(l1, l2) / 2) - 1;

        // 각 문자열에서 어떤 문자가 일치로 표시되었는지 추적
        const s1Matches = new Array(l1).fill(false);
        const s2Matches = new Array(l2).fill(false);

        // 【1단계: 일치하는 문자 찾기】
        let matches = 0;
        for (let i = 0; i < l1; i++) {
            // 현재 문자 s1[i]와 일치할 수 있는 s2의 범위 계산
            const start = Math.max(0, i - matchWindow);
            const end = Math.min(i + matchWindow + 1, l2);

            for (let j = start; j < end; j++) {
                if (s2Matches[j]) continue;  // 이미 매칭된 문자는 스킵
                if (s1[i] === s2[j]) {
                    s1Matches[i] = true;
                    s2Matches[j] = true;
                    matches++;
                    break;  // 이 문자에 대한 매칭 완료
                }
            }
        }

        // 일치하는 문자가 하나도 없으면 유사도 0
        if (matches === 0) return 0;

        // 【2단계: Transposition(순서 차이) 계산】
        // 일치한 문자들의 순서가 다른 경우를 계산
        let t = 0;  // transposition 카운트
        let k = 0;  // s2에서의 현재 위치
        for (let i = 0; i < l1; i++) {
            if (!s1Matches[i]) continue;  // 일치하지 않은 문자는 스킵
            while (!s2Matches[k]) k++;     // s2에서 다음 일치 문자 찾기
            if (s1[i] !== s2[k]) t++;       // 순서가 다르면 transposition
            k++;
        }
        t /= 2;  // transposition은 쌍으로 계산되므로 2로 나눔

        // 【3단계: Jaro 유사도 계산】
        // dj = (일치율_s1 + 일치율_s2 + 순서일치율) / 3
        const dj = (matches / l1 + matches / l2 + (matches - t) / matches) / 3;

        // 【4단계: Winkler 보정 - 공통 접두사 가중치】
        // 앞부분이 같으면 추가 점수 (최대 4자까지만 고려)
        let prefix = 0;
        for (let i = 0; i < Math.min(l1, l2, 4); i++) {
            if (s1[i] === s2[i]) prefix++;
            else break;  // 첫 불일치에서 중단
        }

        // 최종 Jaro-Winkler 점수 반환
        // 접두사가 같을수록 점수가 높아짐 (최대 0.1 * 4 = 0.4 보너스)
        return dj + prefix * 0.1 * (1 - dj);
    }

    /**
     * ────────────────────────────────────────────────────────────────────────────
     * 타임아웃 및 재시도 지원 Fetch 함수
     * ────────────────────────────────────────────────────────────────────────────
     * 
     * 【목적】
     * 네트워크 요청에 타임아웃을 적용하고, 실패 시 자동으로 1회 재시도합니다.
     * LRCLIB 서버의 간헐적 장애나 네트워크 불안정에 대응합니다.
     * 
     * 【동작 방식】
     * 1. AbortController를 사용하여 타임아웃 구현
     * 2. 첫 번째 시도 실패 시 500ms 대기 후 재시도
     * 3. 재시도도 실패하면 null 반환 (에러 throw 대신)
     * 
     * 【설계 결정】
     * - null 반환: UI에 에러 메시지를 노출하지 않기 위함
     * - 500ms 대기: 서버 부하 완화 및 네트워크 복구 시간 확보
     * - 35초 타임아웃: LRCLIB 서버 응답 시간을 고려한 값
     * 
     * @param {string} url - 요청할 URL
     * @param {Object} options - fetch 옵션 (headers 등)
     * @param {number} timeoutMs - 타임아웃 시간 (기본 35초)
     * @returns {Promise<Response|null>} Response 객체 또는 실패 시 null
     */
    async function fetchWithTimeout(url, options = {}, timeoutMs = 35000) {
        // 최대 2회 시도 (첫 시도 + 1회 재시도)
        for (let attempt = 0; attempt < 2; attempt++) {
            // AbortController: fetch 요청을 강제 중단할 수 있게 해주는 Web API
            const controller = new AbortController();

            // 타임아웃 설정: timeoutMs 후 요청 강제 중단
            const id = setTimeout(() => controller.abort(), timeoutMs);

            try {
                // fetch 요청 실행 (signal 연결로 abort 가능하게 함)
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(id);  // 성공 시 타임아웃 타이머 정리
                return response;   // 응답 반환 (성공)
            } catch (error) {
                clearTimeout(id);  // 실패 시에도 타이머 정리

                if (attempt === 0) {
                    // 첫 번째 시도 실패: 500ms 대기 후 재시도
                    await new Promise(r => setTimeout(r, 500));
                    window.__ivLyricsDebugLog?.(`[LR-DEBUG] 네트워크 오류, 재시도 중...`);
                }
                // attempt === 1이면 재시도도 실패 → 루프 종료
            }
        }

        // 모든 재시도 실패 → null 반환 (에러 메시지 노출 방지)
        window.__ivLyricsDebugLog?.(`[LR-DEBUG] 네트워크 재시도 실패, 스킵`);
        return null;
    }

    /**
     * ────────────────────────────────────────────────────────────────────────────
     * 가사 커버리지 계산 함수
     * ────────────────────────────────────────────────────────────────────────────
     * 
     * 【목적】
     * 싱크 가사가 곡의 얼마만큼을 커버하는지 계산합니다.
     * 이를 통해 "짤린 가사"나 "불완전한 가사"를 감지합니다.
     * 
     * 【계산 방법】
     * 1. 가사의 마지막 타임스탬프를 추출
     * 2. (마지막 타임스탬프 / 곡 전체 길이)로 커버리지 계산
     * 3. 결과는 0.0 ~ 1.2 범위로 클램핑
     * 
     * 【반환값 해석】
     * - 0.0: 타임스탬프 없음 또는 계산 불가
     * - 0.5: 곡의 절반만 커버 (불완전한 가사)
     * - 1.0: 곡 전체를 커버
     * - >1.0: 가사가 곡보다 길거나 메타데이터 오류
     * 
     * @param {string} syncedLyrics - LRC 형식의 싱크 가사 문자열
     * @param {number} totalDurationMs - 곡의 전체 길이 (밀리초)
     * @returns {number} 커버리지 비율 (0.0 ~ 1.2)
     */
    function getLyricCoverage(syncedLyrics, totalDurationMs) {
        // 유효성 검사: 가사나 길이 정보가 없으면 0 반환
        if (!syncedLyrics || !totalDurationMs || totalDurationMs <= 0) return 0;

        // 가사를 줄 단위로 분리
        const lines = typeof syncedLyrics === 'string' ? syncedLyrics.trim().split('\n') : [];

        // 뒤에서부터 탐색하여 마지막 타임스탬프 찾기 (효율성)
        for (let i = lines.length - 1; i >= 0; i--) {
            // LRC 타임스탬프 패턴: [MM:SS.xx] 또는 [MM:SS]
            const match = lines[i].match(/\[(\d+):(\d+(\.\d+)?)\]/);
            if (match) {
                // 마지막 타임스탬프를 밀리초로 변환
                const lastTimeMs = (parseInt(match[1]) * 60 + parseFloat(match[2])) * 1000;
                // 커버리지 계산 (1.2를 상한으로 클램핑)
                return Math.min(lastTimeMs / totalDurationMs, 1.2);
            }
        }
        return 0;  // 타임스탬프를 찾지 못함
    }

    /**
     * ────────────────────────────────────────────────────────────────────────────
     * LRC 형식 파싱 함수 (Ultra-Flexible)
     * ────────────────────────────────────────────────────────────────────────────
     * 
     * 【목적】
     * LRC(Lyrics) 형식의 문자열을 파싱하여 구조화된 가사 객체로 변환합니다.
     * 
     * 【LRC 형식 예시】
     * [00:12.34]첫 번째 가사
     * [00:15.67]두 번째 가사
     * [01:00,89]쉼표 구분자도 지원
     * 
     * 【지원하는 형식】
     * - [MM:SS.xx] 또는 [MM:SS,xx]: 밀리초 포함
     * - [MM:SS]: 밀리초 없는 형식
     * - 타임스탬프 없는 일반 텍스트도 unsynced에 포함
     * 
     * 【반환 객체 구조】
     * {
     *   synced: [{ startTime: 12340, text: "첫 번째 가사" }, ...] 또는 null,
     *   unsynced: [{ text: "첫 번째 가사" }, ...]
     * }
     * 
     * @param {string} lrc - LRC 형식의 가사 문자열
     * @returns {Object} { synced: Array|null, unsynced: Array }
     */
    function parseLRC(lrc) {
        // 입력 유효성 검사
        if (!lrc || typeof lrc !== 'string') return { synced: null, unsynced: [] };

        const lines = lrc.split('\n');  // 줄 단위로 분리
        const synced = [];    // 타임스탬프가 있는 가사
        const unsynced = [];  // 텍스트만 있는 가사

        for (const line of lines) {
            // LRC 타임스탬프 패턴 매칭
            // 그룹: [1]=분, [2]=초, [3]=밀리초(선택), [4]=가사 텍스트
            const match = line.match(/\[(\d+):(\d+)(?:[.,](\d+))?\](.*)/);

            if (match) {
                // 타임스탬프가 있는 경우
                const minutes = parseInt(match[1], 10);    // 분
                const seconds = parseInt(match[2], 10);    // 초
                const msPart = match[3] ? parseFloat('0.' + match[3]) : 0;  // 밀리초 부분

                // 시작 시간을 밀리초로 변환
                const startTime = Math.floor((minutes * 60 + seconds + msPart) * 1000);
                const text = match[4].trim();  // 가사 텍스트 (공백 제거)

                synced.push({ startTime, text });  // 싱크 가사에 추가
                unsynced.push({ text });           // 일반 가사에도 추가
            } else if (line.trim() && !line.startsWith('[')) {
                // 타임스탬프 없는 일반 텍스트 (메타데이터 태그 제외)
                unsynced.push({ text: line.trim() });
            }
        }

        // synced가 비어있으면 null로 반환
        return { synced: synced.length > 0 ? synced : null, unsynced };
    }

    // ============================================
    // Addon Implementation (애드온 구현부)
    // ============================================
    // LyricsAddonManager에 등록될 실제 애드온 객체입니다.
    // ADDON_INFO를 스프레드하여 메타데이터를 포함하고,
    // init(), getSettingsUI(), getLyrics() 메서드를 구현합니다.

    const LrclibLyricsAddon = {
        ...ADDON_INFO,  // 메타데이터 병합 (id, name, version 등)

        /**
         * 【초기화 메서드】
         * 애드온이 로드될 때 호출됩니다.
         * 현재는 특별한 초기화 작업이 없어 비어있습니다.
         * 필요시 캐시 초기화, 설정 로드 등을 추가할 수 있습니다.
         */
        async init() {
            // Initialization silent (초기화 시 로그 출력 안 함)
        },

        /**
         * 【설정 UI 메서드】
         * 사용자 설정 화면에 표시될 React 컴포넌트를 반환합니다.
         * 현재는 빈 컨테이너만 반환 (설정 항목 없음)
         * 
         * @returns {Function} React 함수형 컴포넌트
         */
        getSettingsUI() {
            const React = Spicetify.React;  // Spicetify 내장 React 사용

            // 빈 설정 컨테이너 반환
            return function LrclibLyricsSettings() {
                return React.createElement('div', { className: 'lyrics-addon-settings lrclib-settings' });
            };
        },

        /**
         * ────────────────────────────────────────────────────────────────────────────
         * 가사 가져오기 메서드 (getLyrics) - 핵심 메서드
         * ────────────────────────────────────────────────────────────────────────────
         * 
         * 【목적】
         * Spotify에서 재생 중인 트랙의 가사를 LRCLIB API에서 검색하여 반환합니다.
         * 
         * 【입력 파라미터】
         * @param {Object} info - 트랙 정보 객체
         *   - uri: Spotify URI (예: "spotify:track:abc123")
         *   - title: 곡 제목
         *   - artist: 아티스트 이름
         *   - album: 앨범 이름 (사용 안 함)
         *   - duration: 곡 길이 (밀리초)
         * 
         * 【반환값】
         * @returns {Promise<LyricsResult>} 가사 결과 객체
         *   - uri: 트랙 URI
         *   - provider: 'lrclib'
         *   - karaoke: 노래방 가사 (현재 null)
         *   - synced: 싱크 가사 배열 또는 null
         *   - unsynced: 일반 가사 배열 또는 null
         *   - copyright: 저작권 정보 (현재 null)
         *   - error: 에러 메시지 또는 null
         * 
         * 【검색 전략】
         * 구조화 검색 1회 + duration ±3초 필터만 적용
         */
        async getLyrics(info) {
            const startTotal = performance.now();
            const result = {
                uri: info.uri,
                provider: 'lrclib',
                cacheVersion: ADDON_INFO.cacheVersion,
                karaoke: null,
                synced: null,
                unsynced: null,
                copyright: null,
                error: null
            };

            const logDebug = (status, extra = {}) => {
                const endTotal = performance.now();
                window.__ivLyricsDebugLog?.(`[LR-DEBUG] ========================================`);
                window.__ivLyricsDebugLog?.(`[LR-DEBUG] Track: ${info.title} - ${info.artist}`);
                window.__ivLyricsDebugLog?.(`[LR-DEBUG] Status: ${status}`);
                Object.entries(extra).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        window.__ivLyricsDebugLog?.(`[LR-DEBUG] ${key}: ${value}`);
                    }
                });
                window.__ivLyricsDebugLog?.(`[LR-DEBUG] Time - Total: ${(endTotal - startTotal).toFixed(2)}ms`);
                window.__ivLyricsDebugLog?.(`[LR-DEBUG] ========================================`);
            };

            try {
                const title = info?.title?.trim?.();
                const artist = info?.artist?.trim?.();
                const primaryArtist = artist?.split(',')[0]?.trim?.() || artist;
                const trackDurationMs = Number(info?.duration || 0);
                const trackDurationSec = trackDurationMs > 0 ? trackDurationMs / 1000 : 0;
                const normalizedTitle = normalize(title);

                if (!title || !artist || !trackDurationSec) {
                    result.error = 'Missing track metadata';
                    logDebug('Failed', { error: result.error });
                    return result;
                }

                const headers = { 'x-user-agent': `spicetify v${Spicetify.Config?.version || 'unknown'}` };
                const runStructuredSearch = async (artistQuery) => {
                    const normalizedArtistQuery = normalize(artistQuery);
                    const searchUrl = `${LRCLIB_API_BASE}/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artistQuery)}&duration=${encodeURIComponent(Math.round(trackDurationSec))}`;
                    const response = await fetchWithTimeout(searchUrl, { headers }, 35000);

                    if (!response) {
                        return { fatal: true, error: 'Network request failed', searchedArtist: artistQuery };
                    }

                    if (!response.ok) {
                        if (response.status === 429) {
                            return { fatal: true, error: 'Rate limit exceeded (429)', searchedArtist: artistQuery };
                        }
                        if (response.status === 404) {
                            return { fatal: false, error: 'No lyrics found', searchedArtist: artistQuery };
                        }
                        return { fatal: true, error: `API error: ${response.status}`, searchedArtist: artistQuery };
                    }

                    const data = await response.json();
                    if (!Array.isArray(data) || data.length === 0) {
                        return {
                            fatal: false,
                            error: 'No lyrics found',
                            searchedArtist: artistQuery,
                            totalResults: Array.isArray(data) ? data.length : 0,
                            candidates: []
                        };
                    }

                    const candidates = data
                        .filter(item => {
                            const candidateDuration = Number(item?.duration);
                            if (!Number.isFinite(candidateDuration)) return false;
                            if (Math.abs(candidateDuration - trackDurationSec) > LRCLIB_DURATION_TOLERANCE_SEC) return false;
                            if (!item?.syncedLyrics && !item?.plainLyrics && !item?.instrumental) return false;
                            return true;
                        })
                        .map(item => {
                            const durationDiff = Math.abs(Number(item.duration) - trackDurationSec);
                            const titleScore = jaroWinkler(title, item.trackName || '');
                            const artistScore = jaroWinkler(artistQuery, item.artistName || '');
                            const normalizedCandidateTitle = normalize(item.trackName || '');
                            const normalizedCandidateArtist = normalize(item.artistName || '');
                            const titleContains = normalizedCandidateTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedCandidateTitle);
                            const artistContains = normalizedCandidateArtist.includes(normalizedArtistQuery) || normalizedArtistQuery.includes(normalizedCandidateArtist);
                            const syncCoverage = getLyricCoverage(item.syncedLyrics, trackDurationMs);
                            const score = (titleScore * 0.58) + (artistScore * 0.32) + ((LRCLIB_DURATION_TOLERANCE_SEC - durationDiff) / LRCLIB_DURATION_TOLERANCE_SEC * 0.08) + (item.syncedLyrics ? 0.02 : 0);

                            return {
                                ...item,
                                durationDiff,
                                titleScore,
                                artistScore,
                                titleContains,
                                artistContains,
                                syncCoverage,
                                score
                            };
                        })
                        .sort((a, b) => {
                            if (b.score !== a.score) return b.score - a.score;
                            if (a.durationDiff !== b.durationDiff) return a.durationDiff - b.durationDiff;
                            if (!!b.syncedLyrics !== !!a.syncedLyrics) return Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
                            return (b.syncCoverage || 0) - (a.syncCoverage || 0);
                        });

                    return {
                        fatal: false,
                        searchedArtist: artistQuery,
                        totalResults: data.length,
                        candidates
                    };
                };

                const artistQueries = [...new Set([primaryArtist, artist].filter(Boolean))];
                let resolvedSearch = null;
                let lastSearchResult = null;

                for (const artistQuery of artistQueries) {
                    const searchResult = await runStructuredSearch(artistQuery);
                    lastSearchResult = searchResult;

                    if (searchResult.fatal) {
                        result.error = searchResult.error;
                        logDebug('Failed', {
                            error: result.error,
                            searchedArtist: searchResult.searchedArtist
                        });
                        return result;
                    }

                    if (!searchResult.candidates || searchResult.candidates.length === 0) {
                        continue;
                    }

                    const candidate = searchResult.candidates[0];
                    const titleAccepted = candidate.titleContains || candidate.titleScore >= LRCLIB_MIN_TITLE_SCORE;
                    const artistAccepted = candidate.artistContains || candidate.artistScore >= LRCLIB_MIN_ARTIST_SCORE;

                    if (!titleAccepted || !artistAccepted) {
                        continue;
                    }

                    resolvedSearch = searchResult;
                    break;
                }

                if (!resolvedSearch) {
                    result.error = lastSearchResult?.candidates?.length
                        ? 'Low confidence structured match'
                        : (lastSearchResult?.error || `No LRCLIB results within ±${LRCLIB_DURATION_TOLERANCE_SEC}s`);
                    logDebug('Failed', {
                        error: result.error,
                        searchedArtists: artistQueries.join(' -> '),
                        totalResults: lastSearchResult?.totalResults,
                        trackDurationSec: trackDurationSec.toFixed(2)
                    });
                    return result;
                }

                const body = resolvedSearch.candidates[0];
                const usedFallbackArtist = resolvedSearch.searchedArtist !== primaryArtist;

                if (body.instrumental) {
                    result.synced = [{ startTime: 0, text: '♪ Instrumental ♪' }];
                    result.unsynced = [{ text: '♪ Instrumental ♪' }];
                    logDebug('Success', {
                        instrumental: true,
                        matchedCandidates: resolvedSearch.candidates.length,
                        durationDiff: body.durationDiff.toFixed(2),
                        searchedArtist: resolvedSearch.searchedArtist,
                        usedFallbackArtist
                    });
                    return result;
                }

                if (body.syncedLyrics && body.syncCoverage > 0) {
                    const parsed = parseLRC(body.syncedLyrics);
                    result.synced = parsed.synced;
                    if (!result.unsynced) {
                        result.unsynced = parsed.unsynced;
                    }
                }
                else if (body.plainLyrics) {
                    result.unsynced = body.plainLyrics.split('\n').map(line => ({ text: line.trim() })).filter(l => l.text);
                }

                if (!result.synced && body.plainLyrics && !result.unsynced) {
                    result.unsynced = body.plainLyrics.split('\n').map(line => ({ text: line.trim() })).filter(l => l.text);
                }

                if (!result.synced && !result.unsynced) {
                    result.error = 'No lyrics';
                    logDebug('Failed', {
                        error: result.error,
                        matchedCandidates: resolvedSearch.candidates.length,
                        searchedArtist: resolvedSearch.searchedArtist,
                        usedFallbackArtist
                    });
                    return result;
                }

                logDebug('Success', {
                    totalResults: resolvedSearch.totalResults,
                    matchedCandidates: resolvedSearch.candidates.length,
                    titleScore: body.titleScore.toFixed(3),
                    artistScore: body.artistScore.toFixed(3),
                    durationDiff: body.durationDiff.toFixed(2),
                    hasSynced: !!result.synced,
                    hasUnsynced: !!result.unsynced,
                    searchedArtist: resolvedSearch.searchedArtist,
                    usedFallbackArtist
                });
                return result;

            } catch (e) {
                result.error = e.message;
                logDebug('Fatal Error', { error: e.message });
                return result;
            }

        }
    };

    // ============================================
    // Registration (애드온 등록)
    // ============================================
    // LyricsAddonManager에 이 애드온을 등록합니다.
    // Spicetify 로딩 순서에 따라 Manager가 아직 준비되지 않았을 수 있으므로
    // 준비될 때까지 100ms 간격으로 재시도합니다.

    /**
     * 【애드온 등록 함수】
     * window.LyricsAddonManager가 존재하면 애드온을 등록하고,
     * 없으면 100ms 후에 다시 시도합니다 (Polling 패턴).
     */
    const registerAddon = () => {
        if (window.LyricsAddonManager) {
            // Manager 준비됨 → 애드온 등록
            window.LyricsAddonManager.register(LrclibLyricsAddon);
        } else {
            // Manager 미준비 → 100ms 후 재시도
            setTimeout(registerAddon, 100);
        }
    };

    // IIFE 실행 시 즉시 등록 시도 시작
    registerAddon();
})();
