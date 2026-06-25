class Project < Formula
  desc "Template-aware Project CLI"
  homepage "https://github.com/DotNaos/project-space"
  head "https://github.com/DotNaos/project-space.git", using: :git, branch: "main"

  depends_on "go" => :build

  def install
    system "go", "build", "-o", libexec/"project", "./cmd/project"
    pkgshare.install "templates/project-template"
    (zsh_completion/"_project").write Utils.safe_popen_read(libexec/"project", "completion", "zsh")
    (bin/"project").write <<~SH
      #!/bin/bash
      export PROJECT_SPACE_TEMPLATE_ROOT="#{pkgshare}/project-template"
      exec "#{libexec}/project" "$@"
    SH
  end

  test do
    system bin/"project", "--help"
  end
end
