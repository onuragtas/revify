// Builds and deploys the Revify API.
//
// Only the API. The desktop app is built by GitHub Actions
// (.github/workflows/app.yml) — two pipelines because they ship to
// different places on different schedules: the API is one binary on one
// server, the app is installers people download.
//
// This repository is public, which shapes one rule: no secrets, no server
// names, no credentials as literals. Everything environment-specific
// arrives as a Jenkins credential. This file is world-readable and kept
// forever in git history.

pipeline {
  agent any

  options {
    timeout(time: 15, unit: 'MINUTES')
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    booleanParam(
      name: 'DEPLOY',
      defaultValue: false,
      description: 'Deploy the built binary. Only takes effect on the default branch.'
    )
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
        // Cheap, specific, and first: a leak must fail the build before any
        // stage has the chance to publish an artifact containing it.
        sh '''
          set -eu
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
        // -race because this is a server: the bugs worth catching here are
        // the ones that only show up under concurrent requests.
        dir('api') {
          sh 'go test -race -cover ./...'
        }
      }
    }

    stage('Build') {
      steps {
        dir('api') {
          // CGO_ENABLED=0 is the whole point of the pure-Go SQLite driver:
          // one static binary, no libc to match on the target, and a build
          // that cross-compiles from whatever this agent happens to be.
          sh '''
            set -eu
            CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \\
              go build -trimpath -ldflags="-s -w" -o build/revify-api-linux-amd64 ./cmd/api
            file build/revify-api-linux-amd64 || true
            ls -lh build/
          '''
        }
        archiveArtifacts artifacts: 'api/build/revify-api-linux-amd64', fingerprint: true
      }
    }

    stage('Deploy') {
      // Only from the default branch, and only when asked. A pull request
      // that could deploy is a pull request that can replace the service
      // everyone is signed in to.
      when {
        allOf {
          expression { params.DEPLOY }
          branch 'main'
        }
      }
      steps {
        withCredentials([
          sshUserPrivateKey(credentialsId: 'revify-deploy-key', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
          string(credentialsId: 'revify-deploy-host', variable: 'DEPLOY_HOST'),
          string(credentialsId: 'revify-deploy-path', variable: 'DEPLOY_PATH'),
          string(credentialsId: 'revify-health-url', variable: 'HEALTH_URL'),
        ]) {
          sh '''
            set -eu
            SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

            # Upload beside the running binary, then move it into place.
            # Copying onto a running executable is how you get a half-written
            # binary serving requests.
            scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \\
              api/build/revify-api-linux-amd64 "$SSH_USER@$DEPLOY_HOST:$DEPLOY_PATH/revify-api.new"

            $SSH "$SSH_USER@$DEPLOY_HOST" bash -euo pipefail -c "'
              chmod +x $DEPLOY_PATH/revify-api.new
              mv $DEPLOY_PATH/revify-api.new $DEPLOY_PATH/revify-api
              sudo systemctl restart revify-api
            '"
          '''

          // The deploy is not finished until the service answers. A restart
          // that silently failed looks exactly like one that worked.
          sh '''
            set -eu
            for i in $(seq 1 20); do
              if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"ok":true'; then
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

  post {
    always {
      // Leaves nothing behind that a later job on the same agent could read.
      cleanWs()
    }
  }
}
