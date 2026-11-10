# Security policy

## Supported versions

Security fixes target the latest stable release. Unreleased revisions are for
testing and may change before release.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tosto92/punk-records/security/advisories/new)
when it is available. If the private reporting form is unavailable, open an issue
asking for a private contact channel, without disclosing vulnerability details.

Do not publish exploit details, credentials, memory contents or private session
transcripts in issues, pull requests or logs.

Include the affected version, operating system, Node/Python and agent versions,
reproduction steps, expected impact and a minimal sanitized example. Use synthetic
memories or transcripts where possible.

## Scope

Reports about unintended memory or transcript disclosure, unsafe configuration
changes, execution of untrusted content and bypasses of enabled memory protection
are welcome. Describe the configuration and trust boundary involved. Optional
NOVA scanning is a detection layer; a clean scan is not proof that content is safe.
