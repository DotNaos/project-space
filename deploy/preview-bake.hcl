variable "SOURCE_CONTEXT" {
  default = ""
}

variable "TRUSTED_CONTEXT" {
  default = ""
}

variable "PR_NUMBER" {
  default = ""
}

variable "PR_HEAD_SHA" {
  default = ""
}

variable "TRUSTED_WORKFLOW_SHA" {
  default = ""
}

variable "VITE_CLERK_PUBLISHABLE_KEY" {
  default = ""
}

group "preview-images" {
  targets = ["web", "docs", "prototype", "gateway"]
}

target "web" {
  context    = SOURCE_CONTEXT
  dockerfile = "${TRUSTED_CONTEXT}/deploy/preview.web.Dockerfile"
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
    VITE_CLERK_PUBLISHABLE_KEY = VITE_CLERK_PUBLISHABLE_KEY
  }
  tags = [
    "ghcr.io/dotnaos/project-space-preview-web:pr-${PR_NUMBER}-${PR_HEAD_SHA}"
  ]
}

target "docs" {
  context    = SOURCE_CONTEXT
  dockerfile = "${TRUSTED_CONTEXT}/deploy/preview.docs.Dockerfile"
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
  }
  tags = [
    "ghcr.io/dotnaos/project-space-preview-docs:pr-${PR_NUMBER}-${PR_HEAD_SHA}"
  ]
}

target "prototype" {
  context    = SOURCE_CONTEXT
  dockerfile = "${TRUSTED_CONTEXT}/deploy/preview.prototype.Dockerfile"
  contexts = {
    trusted-assets = TRUSTED_CONTEXT
  }
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
  }
  tags = [
    "ghcr.io/dotnaos/project-space-preview-prototype:pr-${PR_NUMBER}-${PR_HEAD_SHA}"
  ]
}

target "gateway" {
  context    = TRUSTED_CONTEXT
  dockerfile = "${TRUSTED_CONTEXT}/deploy/preview.gateway.Dockerfile"
  args = {
    PROJECT_SPACE_BUILD_COMMIT = TRUSTED_WORKFLOW_SHA
  }
  tags = [
    "ghcr.io/dotnaos/project-space-preview-gateway:${TRUSTED_WORKFLOW_SHA}"
  ]
}
