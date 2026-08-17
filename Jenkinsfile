// Revify — master deploy pipeline (API only).
//
// Akış: test → go build (static linux/amd64) → tarball → ssh transfer →
// remote docker compose up --build.
//
// Masaüstü uygulaması burada derlenmez; onu GitHub Actions paketliyor
// (.github/workflows/app.yml). İkisi farklı yerlere gidiyor: API tek
// sunucuda tek binary, uygulama insanların indirdiği kurulum dosyaları.
//
// Önkoşullar:
//   1. Jenkins → Manage Jenkins → Tools:
//        - Go adı: 'go-1.26'   (api/go.mod en az 1.25 istiyor; bunu
//          dayatan golang.org/x/crypto, bizim tercihimiz değil)
//   2. Manage Jenkins → System → Publish over SSH:
//        - Name: 'root-20.29'  (DEPLOY_HOST_CONFIG bunu referans alır)
//   3. GitHub webhook: <jenkins>/github-webhook/ → push event.
//
// Not: ikili Jenkins'te derlenir, uzak sunucuda Go toolchain gerekmez.
// Oradaki imaj Dockerfile.runtime ile yalnızca hazır ikiliyi kopyalar —
// production'a derleyici göndermenin, zaten yapılmış bir işi tekrar
// yaptırmaktan başka anlamı olmazdı.
//
// Bu repo public: hiçbir sır, sunucu adı veya yol bu dosyada literal olarak
// bulunmaz — hepsi Jenkins yapılandırmasından gelir.

pipeline {
    agent any

    options {
        timestamps()
        timeout(time: 20, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '15'))
        disableConcurrentBuilds()
        ansiColor('xterm')
    }

    triggers {
        githubPush()
    }

    tools {
        go 'go-1.26'
    }

    environment {
        DEPLOY_HOST_CONFIG = 'root-20.29'
        REMOTE_DEPLOY_DIR  = '/opt/revify'
        REMOTE_INCOMING    = 'revify-incoming'
        ARTIFACT_NAME      = "revify-api-${env.BUILD_NUMBER}.tar.gz"
        CGO_ENABLED        = '0'
        GOOS               = 'linux'
        GOARCH             = 'amd64'
    }

    stages {
        stage('Checkout') {
            steps {
                // Shallow clone: sadece son commit, history yok → hızlı.
                checkout([
                    $class: 'GitSCM',
                    branches: scm.branches,
                    userRemoteConfigs: scm.userRemoteConfigs,
                    extensions: scm.extensions + [
                        [$class: 'CloneOption', shallow: true, depth: 1, noTags: true],
                        [$class: 'CleanBeforeCheckout']
                    ]
                ])
                sh 'git --no-pager log -1 --pretty="%h %s"'
            }
        }

        stage('Secret scan') {
            steps {
                // Ucuz, hedefli ve ilk: bir sızıntı, onu içeren bir artifact
                // üretilmeden önce build'i düşürmeli. Repo public olduğu için
                // burada yakalanmayan şey sonsuza kadar geçmişte kalır.
                sh '''
                    set -eu
                    if git grep -nIE "glpat-[A-Za-z0-9_-]{20}|ATATT[A-Za-z0-9_-]{20}|sk-ant-[A-Za-z0-9_-]{20}|xoxb-[0-9]{10,}" -- . ; then
                        echo "Bir kimlik bilgisi commit edilmiş görünüyor. Önce iptal et, sonra geçmişten temizle."
                        exit 1
                    fi
                    for tracked in .env config/config.yaml; do
                        if git ls-files --error-unmatch "$tracked" >/dev/null 2>&1; then
                            echo "$tracked takip ediliyor; asla edilmemeli."
                            exit 1
                        fi
                    done
                    echo "Clean."
                '''
            }
        }

        stage('Test') {
            // -race cgo gerektirir ve yalnızca yerel mimaride çalışır.
            // Derleme için gereken CGO_ENABLED=0 / GOOS=linux burada ezilir;
            // testler agent'ın kendi platformunda koşar.
            environment {
                CGO_ENABLED = '1'
                GOOS        = ''
                GOARCH      = ''
            }
            steps {
                dir('api') {
                    // -race, çünkü bu bir sunucu: buradaki yakalanmaya değer
                    // hatalar yalnızca eşzamanlı isteklerde ortaya çıkanlar.
                    // Yetki sınırları (kim neyi çağırabilir) router seviyesinde
                    // test ediliyor; izole bir servis testi, rota yanlış
                    // korumanın altına monte edilmişken de geçerdi.
                    sh 'go vet ./...'
                    sh 'test -z "$(gofmt -l .)" || { echo "gofmt şunları değiştirirdi:"; gofmt -l .; exit 1; }'
                    sh 'go test ./... -race -count=1 -cover'
                }
            }
        }

        stage('Build') {
            steps {
                dir('api') {
                    sh '''
                        set -eu
                        mkdir -p ../dist/bin
                        LDFLAGS="-s -w -X main.buildNumber=${BUILD_NUMBER} -X main.gitCommit=$(git rev-parse --short HEAD)"
                        go build -trimpath -ldflags "$LDFLAGS" -o ../dist/bin/revify-api ./cmd/api
                        file ../dist/bin/revify-api || true
                        ls -lh ../dist/bin/revify-api
                    '''
                }
            }
        }

        stage('Package artifacts') {
            steps {
                sh '''
                    set -eu
                    rm -rf artifacts && mkdir -p artifacts/bin artifacts/deploy

                    cp dist/bin/revify-api artifacts/bin/
                    chmod +x artifacts/bin/revify-api

                    # Imaj tanımı, compose ve deploy betiği ikiliyle birlikte
                    # gider: uzak sunucuda ayrı bir repo klonu gerekmesin.
                    cp api/Dockerfile.runtime          artifacts/
                    cp deploy/docker-compose.prod.yml  artifacts/docker-compose.yml
                    cp deploy/remote-deploy.sh         artifacts/deploy/
                    chmod +x artifacts/deploy/remote-deploy.sh

                    cat > artifacts/BUILD_INFO <<EOF
build_number=${BUILD_NUMBER}
git_commit=$(git rev-parse HEAD)
git_branch=$(git rev-parse --abbrev-ref HEAD)
built_at=$(date -u +%FT%TZ)
EOF

                    tar -czf "${ARTIFACT_NAME}" -C artifacts .
                    ls -lh "${ARTIFACT_NAME}"
                '''
            }
        }

        stage('Deploy via SSH') {
            // Yalnızca master. Deploy edebilen bir pull request, herkesin
            // giriş yaptığı servisi değiştirebilen bir pull request demek.
            when { branch 'master' }
            steps {
                sshPublisher(
                    publishers: [
                        sshPublisherDesc(
                            configName: "${DEPLOY_HOST_CONFIG}",
                            verbose: true,
                            transfers: [
                                sshTransfer(
                                    sourceFiles: "${ARTIFACT_NAME}",
                                    remoteDirectory: "${REMOTE_INCOMING}",
                                    removePrefix: '',
                                    execCommand: """
                                        set -euo pipefail
                                        INCOMING=\$(cd ~ && pwd)/${REMOTE_INCOMING}
                                        cd \"\$INCOMING\"
                                        echo '==> Extracting'
                                        rm -rf staging && mkdir staging
                                        tar -xzf ${ARTIFACT_NAME} -C staging
                                        chmod +x staging/deploy/remote-deploy.sh
                                        echo '==> Running deploy script'
                                        DEPLOY_DIR=${REMOTE_DEPLOY_DIR} BUILD_NUMBER=${BUILD_NUMBER} bash staging/deploy/remote-deploy.sh
                                    """,
                                    execTimeout: 1200000
                                )
                            ]
                        )
                    ]
                )
            }
        }
    }

    post {
        success { echo "✅ Deploy başarılı: build #${env.BUILD_NUMBER} → ${env.REMOTE_DEPLOY_DIR}" }
        failure { echo "❌ Deploy başarısız — log'a bak. Remote'da: docker compose -f ${env.REMOTE_DEPLOY_DIR}/docker-compose.yml ps && docker compose -f ${env.REMOTE_DEPLOY_DIR}/docker-compose.yml logs --tail=50" }
        always  { sh 'rm -f revify-api-*.tar.gz || true' }
    }
}
