variable "SOURCE_CONTEXT" {
  default = "."
}

variable "ARTIFACT_DIR" {
  default = "preview-artifact"
}

variable "PR_NUMBER" {
  default = ""
}

variable "PR_HEAD_SHA" {
  default = ""
}

variable "VITE_CLERK_PUBLISHABLE_KEY" {
  default = ""
}

group "preview-artifacts" {
  targets = ["web", "docs", "prototype"]
}

target "web" {
  context    = SOURCE_CONTEXT
  dockerfile = "${SOURCE_CONTEXT}/deploy/preview.web.Dockerfile"
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
    VITE_CLERK_PUBLISHABLE_KEY = VITE_CLERK_PUBLISHABLE_KEY
  }
  tags = ["project-space-preview-web:pr-${PR_NUMBER}-${PR_HEAD_SHA}"]
  output = ["type=docker,dest=${ARTIFACT_DIR}/images/web.tar"]
}

target "docs" {
  context    = SOURCE_CONTEXT
  dockerfile = "${SOURCE_CONTEXT}/deploy/preview.docs.Dockerfile"
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
  }
  tags = ["project-space-preview-docs:pr-${PR_NUMBER}-${PR_HEAD_SHA}"]
  output = ["type=docker,dest=${ARTIFACT_DIR}/images/docs.tar"]
}

target "prototype" {
  context    = SOURCE_CONTEXT
  dockerfile = "${SOURCE_CONTEXT}/deploy/preview.prototype.Dockerfile"
  contexts = {
    trusted-assets = SOURCE_CONTEXT
  }
  args = {
    PROJECT_SPACE_BUILD_COMMIT = PR_HEAD_SHA
  }
  tags = ["project-space-preview-prototype:pr-${PR_NUMBER}-${PR_HEAD_SHA}"]
  output = ["type=docker,dest=${ARTIFACT_DIR}/images/prototype.tar"]
}
