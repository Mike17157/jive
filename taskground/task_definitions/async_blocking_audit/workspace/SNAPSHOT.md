# Snapshot provenance

The Home Assistant files are unmodified selections from the `2024.9.0` tag of
`home-assistant/core`, commit
`36ec1b33fe0039d838586730768730c2ea4e054c`. The Home Assistant Apache 2.0
license is preserved as `source/HOME_ASSISTANT_LICENSE.md`.

Dependency source comes from these PyPI source distributions:

| Distribution | Version | Source archive SHA-256 |
| --- | ---: | --- |
| `yalesmartalarmclient` | 0.4.0 | `ccf148af7315eb29959f508663064972379859c6b5aae6ccbcacb54b0ba5b3e2` |
| `micloud` | 0.5 | `d5d77c40c182b20fa256c8c1b5383eb296515f1f75418e997c75465e5e1af403` |
| `tzlocal` | 5.2 | `8d399205578f1a9342816409cc1e46a93ebd5755e39ea2d85334bea911bf0e6e` |

`tzlocal` is a transitive, unpinned requirement of `micloud`; version 5.2 was
the current compatible PyPI release at the Home Assistant snapshot date. It is
included to make one representative cold constructor path inspectable. Treat
that resolution detail as a limitation rather than claiming every installation
used the same transitive version.

The selected files are static evidence. They do not form an executable Home
Assistant installation and include no user or production data.
