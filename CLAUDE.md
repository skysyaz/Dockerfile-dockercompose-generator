# CLAUDE.md - Development Guide for Dockerfile-dockercompose-generator

This document provides guidance for AI assistants (Claude and other tools) working on this repository.

## Project Overview

**Dockerfile-dockercompose-generator** is a utility tool designed to generate Dockerfiles and Docker Compose configuration files. The project aims to simplify the process of creating containerization configurations by automating or assisting in their generation.

### Project Purpose
- Generate Dockerfiles based on project specifications
- Generate Docker Compose files for multi-container deployments
- Potentially assist in validating and optimizing container configurations

## Repository Structure

The repository is organized as follows (subject to expansion):

```
Dockerfile-dockercompose-generator/
├── README.md                  # Project overview and quick start
├── CLAUDE.md                  # This file - AI assistant guidelines
├── src/                       # Source code (to be created)
│   ├── index.js/ts           # Main entry point
│   └── ...                    # Core implementation
├── tests/                     # Test files (to be created)
├── docs/                      # Documentation (to be created)
├── .github/                   # GitHub-specific files
│   ├── workflows/            # CI/CD pipelines
│   └── pull_request_template.md
├── package.json              # NPM package configuration (if applicable)
├── .gitignore
└── .env.example              # Environment template (if applicable)
```

## Technology Stack

**Primary Language:** To be determined (likely JavaScript/TypeScript or Python based on project name)

**Key Dependencies:** To be specified in package.json/requirements.txt

**Development Tools:**
- Git for version control
- GitHub for collaboration and CI/CD

## Development Workflows

### Branch Strategy

- **`main`**: Production-ready code. All changes must go through pull requests.
- **Feature Branches**: Named `feature/description` or `fix/description` for general work
- **Current Development Branch**: `claude/claude-md-docs-tsj01e` - Use this for documentation and setup tasks

### Commit Guidelines

1. **Commit Messages**: Use clear, descriptive messages following conventional commits:
   - `feat: add feature description`
   - `fix: resolve issue description`
   - `docs: update documentation`
   - `refactor: restructure code`
   - `test: add or update tests`
   - `chore: update dependencies, config, etc.`

2. **Atomic Commits**: Each commit should represent a single logical change
3. **Co-authoring**: When appropriate, include co-author information for paired work

### Pull Request Process

1. Create a feature branch from `main`
2. Make focused changes with clear commit messages
3. Push to origin and create a pull request
4. Ensure all CI checks pass before merging
5. Request review from team members
6. Squash-and-merge or rebase-and-merge based on project convention (to be established)

### Testing & Validation

- Write tests for new features (location TBD: `tests/` directory)
- Run tests locally before pushing
- Ensure code passes linting (linter config TBD)
- Verify functionality end-to-end

## Key Conventions for AI Assistants

### Code Style

- **Indentation**: 2 or 4 spaces (to be standardized - check project when setup)
- **Naming**: Use camelCase for variables/functions, PascalCase for classes
- **Comments**: Minimal comments; let code be self-documenting. Add comments only for non-obvious WHY, not WHAT
- **Line Length**: Keep lines under 100 characters when reasonable

### Security Considerations

- Never commit secrets, API keys, or credentials
- Use `.env` files for sensitive configuration (never commit `.env`, use `.env.example` as template)
- Validate all external inputs
- Be cautious with Docker/container operations

### Documentation

- Keep README.md updated with:
  - Project description
  - Installation instructions
  - Usage examples
  - Contributing guidelines
- Add inline documentation for complex logic (rare)
- Update CLAUDE.md as conventions evolve

### Error Handling

- Provide meaningful error messages
- Log errors appropriately for debugging
- Handle edge cases gracefully

### Dependencies

- Keep dependencies minimal and up-to-date
- Document why new dependencies are needed
- Use lockfiles (package-lock.json / poetry.lock / etc.) for reproducibility
- Review security advisories regularly

## Development Guidelines for AI Assistants

### When Working on This Project

1. **Read this file first**: Understand the project context before making changes
2. **Respect the branch structure**: Use the designated branch for your work
3. **Create focused changes**: One feature/fix per branch/PR
4. **Write tests**: Add tests alongside code changes
5. **Verify locally**: Test changes before pushing
6. **Document as you go**: Update README/docs with new features

### When Adding Features

1. Consider the project's scope and goals
2. Plan implementation with clear steps
3. Write code following the style guide above
4. Add comprehensive tests
5. Update documentation
6. Request review before merge

### When Fixing Bugs

1. Identify the root cause
2. Write a minimal fix (don't refactor while fixing)
3. Add a test that catches the regression
4. Document the issue and solution if non-obvious

### When Refactoring

1. Don't mix refactoring with feature development
2. Ensure tests pass before and after
3. Keep each refactor focused and reviewable
4. Document what and why, not just the changes

## CI/CD Pipeline

**Current Status**: To be configured

The project will eventually have GitHub Actions workflows for:
- Running tests on every push
- Linting code quality checks
- Security scanning
- Building and publishing releases (if applicable)

See `.github/workflows/` for workflow definitions.

## Package Management

**Current Status**: To be established

When dependencies are added:
- Use npm, yarn, pip, or other appropriate package manager
- Lock dependency versions for reproducibility
- Document any peer dependencies
- Keep dev dependencies separate from production

## Known Issues & Technical Debt

- **Early Stage Project**: This is a freshly initialized project
- **TBD**: Repository structure, tech stack, and initial features to be defined

## Contributing

### For New Contributors

1. Read this CLAUDE.md file
2. Check the README for setup instructions
3. Look at existing code patterns
4. Start with issues marked `good-first-issue` (when available)
5. Ask questions in PRs or discussions

### Code Review Expectations

- All code must be reviewed before merging
- Reviewers should check for:
  - Correctness and logic
  - Test coverage
  - Code style adherence
  - Documentation completeness
  - Security concerns

## Getting Help

- **Questions**: Open a GitHub discussion or issue
- **Bugs**: File an issue with reproduction steps
- **Features**: Propose ideas as discussions or issues

## Important Notes for AI Assistants

- **Do not** make assumptions about unspecified conventions - ask or document TBD items
- **Do prioritize** security, especially for container-related operations
- **Do keep** commits focused and reversible
- **Do not** add unnecessary complexity or premature abstractions
- **Do leverage** existing patterns - avoid one-offs
- **Do think** about edge cases and error scenarios
- **Do maintain** this CLAUDE.md as the project evolves

## Last Updated

- **Date**: 2026-07-19
- **Status**: Initial creation - project foundation documentation
- **Next Steps**: 
  - Define primary technology stack (JavaScript/TypeScript/Python)
  - Establish project features and scope
  - Set up initial project structure
  - Configure CI/CD pipelines
  - Add first implementation

---

**Version**: 1.0  
**Owner**: Project Team  
**Maintenance**: This file should be updated as the project evolves and new conventions are established.
