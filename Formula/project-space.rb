class ProjectSpace < Formula
  desc "Project Space local runtime, CLI, and MCP server"
  homepage "https://github.com/DotNaos/project-space"
  url "https://github.com/DotNaos/project-space/releases/download/v0.3.0/project-space_darwin_arm64.tar.gz"
  version "0.3.0"
  sha256 "REPLACE_WITH_RELEASE_SHA256"

  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "project-space"
  end

  service do
    run [opt_bin/"project-space", "serve"]
    environment_variables PROJECT_SPACE_HOST: "127.0.0.1", PROJECT_SPACE_PORT: "4173"
    keep_alive true
    log_path var/"log/project-space.log"
    error_log_path var/"log/project-space.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/project-space --version")
  end
end
