const SCP_LIKE = /^[^@/]+@(?<host>[^:/]+):(?<path>.+)$/ // git@github.com:foo/bar.git

export function normalizeRepository(input: string): {
    url: string
    key: string
    name: string
} {
    const raw = input.trim()
    let host: string
    let path: string

    const scp = SCP_LIKE.exec(raw)
    if (scp?.groups) {
        host = scp.groups.host
        path = scp.groups.path
    } else {
        let parsed: URL
        try {
            parsed = new URL(raw)
        } catch {
            throw new Error(`"${raw}" is not a valid repository URL`)
        }
        if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
            throw new Error(
                `unsupported protocol "${parsed.protocol}" in "${raw}"`
            )
        }
        host = parsed.host
        path = parsed.pathname
    }

    const slug = path
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
    if (!host || !slug) {
        throw new Error(`"${raw}" is missing a host or repository path`)
    }

    const name = slug.slice(slug.lastIndexOf("/") + 1)

    return {
        url: raw.replace(/\/+$/, ""),
        key: `${host.toLowerCase()}/${slug.toLowerCase()}`,
        name
    }
}
