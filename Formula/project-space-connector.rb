class ProjectSpaceConnector < Formula
  desc "Local connector for Project Space web and machine operations"
  homepage "https://project-space-mu.vercel.app/connector"
  url "https://github.com/DotNaos/project-space/releases/download/v0.2.0/project-space-connector-v0.2.0-darwin-arm64.tar.gz"
  version "0.2.0"
  sha256 "e8b439289d277618c3bf3165864a4b4373b00dc59619b6c06eaddde76c2331dd"

  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "project-space-connector"
  end

  service do
    run [opt_bin/"project-space-connector"]
    environment_variables PROJECT_CONNECTOR_HUB_URL: "https://projects.os-home.net",
      PROJECT_CONNECTOR_SERVICE_NAME: "project-space-connector",
      PROJECT_SPACE_HOST: "127.0.0.1",
      PROJECT_SPACE_PORT: "4173"
    keep_alive true
    log_path var/"log/project-space-connector.log"
    error_log_path var/"log/project-space-connector.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/project-space-connector --version")
  end
end
