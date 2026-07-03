# Security Policy

## Supported Versions

Security updates are provided only for the latest version of this website currently deployed from the default branch.

| Version                       | Supported          |
| ----------------------------- | ------------------ |
| Latest production release     | :white_check_mark: |
| Previous or archived versions | :x:                |
| Unmerged development branches | :x:                |

Users should ensure that they are using the latest published version before reporting a security issue.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues, pull requests, discussions, or comments.

Use GitHub's **Private vulnerability reporting** feature available through the repository's **Security** tab.

A vulnerability report should include, where possible:

* A clear description of the vulnerability.
* The affected page, component, file, or URL.
* Steps required to reproduce the issue.
* The potential security impact.
* Screenshots, logs, or proof-of-concept information.
* Any suggested remediation.

Please do not include passwords, API keys, access tokens, personal information, or other sensitive information unless specifically requested through a secure communication channel.

## Response Process

After receiving a vulnerability report:

1. The report will normally be acknowledged within five working days.
2. The reported issue will be investigated and assessed.
3. Additional information may be requested from the reporter.
4. The reporter will be informed whether the vulnerability has been accepted, requires further investigation, or has been declined.
5. Accepted vulnerabilities will be corrected according to their severity and potential impact.
6. Details of the vulnerability should not be publicly disclosed until a fix has been released.

Submitting a report does not guarantee that the issue will be classified as a security vulnerability.

## Responsible Disclosure

Security researchers are asked to:

* Make a reasonable effort to avoid accessing, modifying, or deleting data.
* Avoid disrupting the website or its supporting services.
* Avoid denial-of-service testing, automated high-volume scanning, or social-engineering attacks.
* Stop testing immediately if sensitive or personal information is encountered.
* Allow reasonable time for the vulnerability to be investigated and corrected before public disclosure.

Reports made in good faith and in accordance with this policy will be handled responsibly.

## Repository Change Control

All changes to the website, source code, configuration, workflows, dependencies, documentation, and security-related files must be submitted through a pull request.

No pull request may be merged into a protected branch without review and approval from the repository owner.

Direct pushes, force pushes, branch deletion, and attempts to bypass the required review process are not permitted unless performed by the repository owner for emergency recovery or repository administration.

Contributors may propose changes, but they are not authorised to approve or merge their own changes.

The repository owner retains final authority over:

* Source-code changes.
* Website content changes.
* Dependency updates.
* GitHub Actions workflows.
* Deployment configuration.
* Repository settings.
* Security configuration.
* Release approval.
* Pull-request approval and merging.

Unauthorised changes must not be deployed to the production website.

## Security-Sensitive Files

Changes to the following files and locations require explicit approval from the repository owner:

* `.github/`
* `.github/workflows/`
* `.github/CODEOWNERS`
* `.github/SECURITY.md`
* Dependency and lock files.
* Build and deployment configuration.
* Environment configuration templates.
* Authentication and authorisation code.
* Server, hosting, domain, and security configuration.

Secrets, credentials, tokens, private keys, passwords, and production environment values must never be committed to the repository.
