# 한글 업로드 테스트 문서

hangul-safety.hwp / hangul-safety.hwpx는 이 프로젝트에서 작성한 테스트 전용 자료입니다. 산업현장 안전에 관한 예시 문단, 3×2 표, 직접 그린 도형 이미지를 포함합니다. 외부/사용자 문서나 개인정보를 포함하지 않습니다.

rhwp v0.8.7의 scaffold와 edit insert-image로 HWPX를 작성하고 convert --verify로 HWP 5를 저장했습니다. 기본 대체 글꼴이 AppleGothic인 macOS에서 변환 결과는 3페이지입니다. 다른 OS/글꼴에서는 쪽 나눔이 달라질 수 있어 native 테스트는 EDUFLOW_TEST_HWP_CONVERTER를 명시할 때만 실행합니다.
