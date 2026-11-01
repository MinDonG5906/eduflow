# ParseFixer 실행 어댑터

이 폴더는 자체 파서를 구현하지 않는다. [업스트림 ParseFixer](https://github.com/iLearn-Lab/CVPRW26-ParseFixer/tree/c3d48d2a7d17a13c526ff0fa42731f389a3bbf83)의 전체 페이지 판독과 선택적 보정을 실행하고, 초기/최종 Markdown을 에듀플로우에 반환한다. 업스트림은 Apache-2.0 라이선스다. 이미지의 SHA-256과 소스 커밋을 함께 반환하여 다른 페이지나 버전의 응답을 차단한다.

## 실행 환경

MinerU2.5 Pro 모델과 해당 backend를 지원하는 별도 머신이 필요하다. 기본 backend는 업스트림과 같은 `vllm-engine`이다. 이 작업을 진행한 Mac은 ARM64, RAM 8GiB이며 전체 모델 실행 환경을 설치하지 않았다. 이 어댑터의 Python 구문만 로컬 검증했고, 전체 모델 실행은 아직 검증하지 않았다.

1. 업스트림을 복제하고 아래 커밋으로 고정한다. 기존 사용자 checkout은 사용하지 않는다.
2. 업스트림 README의 Python 환경·의존성을 설치하고 MinerU 모델을 준비한다. 업스트림 requirements는 전이 의존성까지 고정한 lockfile은 아니므로 운영 배포 전 실제 실행 환경을 별도로 고정해야 한다.
3. 환경변수를 설정하고 이 저장소의 `worker.py`를 실행한다.

```sh
git clone https://github.com/iLearn-Lab/CVPRW26-ParseFixer.git
git -C CVPRW26-ParseFixer checkout c3d48d2a7d17a13c526ff0fa42731f389a3bbf83
# 위 저장소의 README에 따라 별도 가상환경과 모델 설치
export PARSEFIXER_SOURCE=/absolute/path/CVPRW26-ParseFixer
export MINERU_MODEL_PATH=/absolute/path/MinerU2.5-Pro-2604-1.2B
export EDUFLOW_PARSEFIXER_KEY='<24자 이상의 별도 서버 토큰>'
python /absolute/path/storyboard/services/parsefixer/worker.py
```

`127.0.0.1:8765`에서만 수신한다. 에듀플로우가 다른 PC에 있으면 SSH 터널 또는 인증된 HTTPS reverse proxy로 연결한다. 토큰을 Git이나 브라우저에 저장하지 않는다. HTTP 공개 바인딩은 제공하지 않는다.

## 비용·실패 처리

업스트림의 유료 Gemini/OpenAI fallback은 모두 `none`으로 비활성화한다. 에듀플로우는 원본 이미지 기반 판독 1회만 수행하며 기존 비용 장부를 공유한다. 별도 AI 재검수는 제거했다. 따라서 업스트림 논문의 전체 유료 모델 조합을 재현한 설정은 아니다. ParseFixer의 로컬 MinerU 보정은 실행한다.

페이지마다 새 임시 디렉터리에서 실행하고, 480초 제한·단일 요청 처리·15MB 이미지 제한을 적용한다. 파서 실패나 ASC 실패를 정상 결과로 돌려주지 않는다. 업스트림 모델의 응답 및 traceback은 HTTP 응답이나 서버 로그에 노출하지 않는다. HTTP 성공은 원본 일치 판정이 아니며, 후속 에듀플로우 판독·저장 단계로 전달한다.
