import pytest

from generator import DockerConfigGenerator, GITHUB_URL_PATTERN


def test_github_url_validation():
    assert GITHUB_URL_PATTERN.match("https://github.com/user/repo")
    assert GITHUB_URL_PATTERN.match("https://github.com/user/repo.git")
    assert not GITHUB_URL_PATTERN.match("https://gitlab.com/user/repo")


def test_invalid_url_raises():
    with pytest.raises(ValueError):
        DockerConfigGenerator("https://gitlab.com/user/repo")


def test_repo_name_extraction():
    generator = DockerConfigGenerator("https://github.com/octocat/Hello-World")
    assert generator.repo_name == "Hello-World"


def test_detect_node_framework(tmp_path):
    repo_dir = tmp_path / "demo-app"
    repo_dir.mkdir()
    (repo_dir / "package.json").write_text('{"name":"demo"}')

    generator = DockerConfigGenerator(
        "https://github.com/user/demo-app",
        work_dir=str(tmp_path),
    )
    generator.repo_dir = str(repo_dir)

    assert generator.detect_framework() == "node"
    assert "node:20-alpine" in generator.generate_dockerfile("node")
    assert "3000:3000" in generator.generate_docker_compose("node")


def test_detect_django_over_python(tmp_path):
    repo_dir = tmp_path / "django-app"
    repo_dir.mkdir()
    (repo_dir / "requirements.txt").write_text("django\n")
    (repo_dir / "manage.py").write_text("# django\n")

    generator = DockerConfigGenerator(
        "https://github.com/user/django-app",
        work_dir=str(tmp_path),
    )
    generator.repo_dir = str(repo_dir)

    assert generator.detect_framework() == "django"
    assert "manage.py" in generator.generate_dockerfile("django")
    assert "postgres:16" in generator.generate_docker_compose("django")
