// CI for a public repository.
//
// Two rules shape everything here, and both come from the repo being public:
//
//  1. No secrets, no internal hostnames, no team or project names. Anything
//     environment-specific arrives through Jenkins credentials or job
//     parameters — never as a literal in this file, which is world-readable
//     and kept forever in git history.
//
//  2. Nothing this pipeline runs may reach a real Jira, GitLab or model.
//     The app is built to change real tickets; a CI job that could do that
//     from a fork's pull request would be a way to move other people's work.
//     The build never creates config/config.yaml or .env, so the code paths
//     that write to Jira cannot even be configured, let alone triggered.

pipeline {
  agent any

  options {
    timeout(time: 20, unit: 'MINUTES')
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    booleanParam(
      name: 'BUILD_DESKTOP',
      defaultValue: false,
      description: 'Package the Electron desktop app. Off by default: it downloads hundreds of MB and is only useful for a release.'
    )
    booleanParam(
      name: 'DEPLOY_API',
      defaultValue: false,
      description: 'Deploy the API to the server. Only meaningful on the default branch; see the Deploy stage.'
    )
  }

  environment {
    // Keeps npm's cache inside the workspace so parallel agents cannot
    // fight over a shared home directory.
    NPM_CONFIG_CACHE = "${WORKSPACE}/.npm"
    CI = 'true'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        sh 'git --no-pager log -1 --pretty="%h %s"'
      }
    }

    stage('Secret scan') {
      steps {
        // Cheap and specific: catches the mistake this repository is most
        // exposed to — a real credential or an internal host committed by
        // accident. Runs first so a leak fails the build before anything
        // else has a chance to publish an artifact containing it.
        sh '''
          set -eu
          echo "Scanning tracked files for credentials and internal hosts..."
          if git grep -nIE "glpat-[A-Za-z0-9_-]{20}|ATATT[A-Za-z0-9_-]{20}|sk-ant-[A-Za-z0-9_-]{20}|xoxb-[0-9]{10,}" -- . ; then
            echo "A credential appears to be committed. Rotate it, then remove it from history."
            exit 1
          fi
          for tracked in .env config/config.yaml; do
            if git ls-files --error-unmatch "$tracked" >/dev/null 2>&1; then
              echo "$tracked is tracked but must never be: it holds credentials or environment config."
              exit 1
            fi
          done
          echo "Clean."
        '''
      }
    }

    stage('App') {
      stages {
        stage('Install') {
          // `npm ci` rather than `install`: it installs exactly the lockfile
          // and fails if package.json and the lock disagree, so CI cannot
          // silently test a different dependency tree than a developer has.
          steps { sh 'npm ci' }
        }

        stage('Typecheck') {
          steps { sh 'npx tsc --noEmit' }
        }

        stage('Test') {
          steps { sh 'npm test' }
        }

        stage('Build') {
          steps {
            sh 'npm run build'
            // The UI is a single file copied by the build; if that copy ever
            // breaks, every run mode serves a blank page.
            sh 'test -f dist/web/public/index.html'
            sh 'test -f dist/adapters/tasks/prompts/codeReview.md'
          }
        }

        stage('Smoke') {
          steps {
            // Proves the built server actually starts and serves the UI —
            // a compile that produces something unrunnable still passes tsc.
            // Config comes from the example files so no real credentials are
            // needed and nothing can reach a real Jira.
            sh '''
              set -eu
              cp config/config.example.yaml config/config.yaml
              cat > .env <<'ENVEOF'
JIRA_BASE_URL=https://example.invalid
JIRA_EMAIL=ci@example.invalid
JIRA_API_TOKEN=ci-not-a-real-token
GITLAB_BASE_URL=https://example.invalid
GITLAB_TOKEN=ci-not-a-real-token
ENVEOF

              UI_PORT=4399 node dist/web/index.js > smoke.log 2>&1 &
              SERVER_PID=$!
              trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

              for i in $(seq 1 30); do
                if curl -fsS -o /dev/null http://127.0.0.1:4399/; then
                  echo "UI is up."
                  break
                fi
                if [ "$i" = "30" ]; then
                  echo "Server never became ready:"; cat smoke.log; exit 1
                fi
                sleep 1
              done

              curl -fsS http://127.0.0.1:4399/api/outcome-config | grep -q applyChanges

              # The example config must ship with Jira writes off. If this
              # ever flips, a fresh clone becomes one command away from
              # commenting on real issues.
              curl -fsS http://127.0.0.1:4399/api/outcome-config | grep -q '"applyChanges":false'
            '''
          }
          post {
            always {
              // Never archived: these were written by this stage and hold
              // placeholder credentials, but the habit matters more than
              // this instance.
              sh 'rm -f .env config/config.yaml smoke.log'
            }
          }
        }
      }
    }

    stage('API') {
      // The Revify API lives outside this repository (see .gitignore), so on a
      // public checkout this directory simply is not there. Skipping is the
      // correct outcome, not a failure.
      when { expression { fileExists('api/go.mod') } }
      stages {
        stage('Vet') {
          steps {
            dir('api') {
              sh 'go vet ./...'
              sh 'test -z "$(gofmt -l .)" || { echo "gofmt would change:"; gofmt -l .; exit 1; }'
            }
          }
        }
        stage('Test') {
          steps {
            dir('api') {
              sh 'go test -race -cover ./...'
            }
          }
        }
        stage('Build') {
          steps {
            dir('api') {
              // CGO_ENABLED=0 is the whole point of the pure-Go SQLite
              // driver: one static binary, no libc to match, and a build
              // that cross-compiles from whatever this agent happens to be.
              sh '''
                set -eu
                CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
                  go build -trimpath -ldflags="-s -w" -o build/revify-api-linux-amd64 ./cmd/api
                CGO_ENABLED=0 go build -trimpath -o build/revify-api ./cmd/api
                ls -lh build/
              '''
            }
            archiveArtifacts artifacts: 'api/build/revify-api*', fingerprint: true
          }
        }

        stage('Deploy') {
          // Only from the default branch, and only when asked. A pull
          // request that could deploy is a pull request that can replace
          // the service everyone is signed in to.
          when {
            allOf {
              expression { params.DEPLOY_API }
              branch 'main'
            }
          }
          steps {
            // Every environment-specific value arrives as a Jenkins
            // credential. None of it is in this file, which is public and
            // kept forever in git history.
            withCredentials([
              sshUserPrivateKey(credentialsId: 'revify-deploy-key', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
              string(credentialsId: 'revify-deploy-host', variable: 'DEPLOY_HOST'),
              string(credentialsId: 'revify-deploy-path', variable: 'DEPLOY_PATH'),
            ]) {
              sh '''
                set -eu
                SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

                # Upload beside the running binary, then move into place:
                # copying onto a running executable is how you get a
                # half-written binary serving requests.
                scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
                  api/build/revify-api-linux-amd64 "$SSH_USER@$DEPLOY_HOST:$DEPLOY_PATH/revify-api.new"

                $SSH "$SSH_USER@$DEPLOY_HOST" bash -euo pipefail -c "'
                  chmod +x $DEPLOY_PATH/revify-api.new
                  mv $DEPLOY_PATH/revify-api.new $DEPLOY_PATH/revify-api
                  sudo systemctl restart revify-api
                  sudo systemctl is-active --quiet revify-api
                '"
              '''

              // The deploy is not finished until the service answers. A
              // restart that silently failed looks exactly like success.
              sh '''
                set -eu
                for i in $(seq 1 20); do
                  if curl -fsS --max-time 5 https://revify.resoft.org/api/health | grep -q '"ok":true'; then
                    echo "Health check passed."
                    exit 0
                  fi
                  sleep 3
                done
                echo "Service did not become healthy after the deploy."
                exit 1
              '''
            }
          }
        }
      }
    }

    stage('Desktop') {
      when { expression { params.BUILD_DESKTOP } }
      steps {
        // REVIFY_ENV is what decides which backend the build talks to. It
        // is baked in at build time on purpose — see src/core/backendUrl.ts.
        sh 'REVIFY_ENV=production npm run build'
        sh 'npx --yes electron-builder --dir --publish never'
      }
      post {
        success {
          archiveArtifacts artifacts: 'release/**/*', allowEmptyArchive: true, fingerprint: true
        }
      }
    }
  }

  post {
    always {
      // Leaves nothing behind that a later job on the same agent could read.
      cleanWs()
    }
  }
}
