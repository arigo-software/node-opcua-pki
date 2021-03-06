import {hostname} from "os";

function trim(str: string, length: number): string {
    if (!length) {
        return str;
    }
    return str.substr(0, Math.min(str.length, length));
}

let _fullyQualifiedDomainNameCache: string | null = null;

export function get_fully_qualified_domain_name(maxLength?: number): string {

    maxLength = maxLength ? maxLength : 0;

    if (_fullyQualifiedDomainNameCache) {
        return trim(_fullyQualifiedDomainNameCache, maxLength);
    }
    let fqdn: any;
    if (process.platform === "win32") {

        // http://serverfault.com/a/73643/251863
        const env = process.env;
        fqdn = env.COMPUTERNAME + ( (env.USERDNSDOMAIN && env.USERDNSDOMAIN.length > 0) ? "." + env.USERDNSDOMAIN : "");
        _fullyQualifiedDomainNameCache = fqdn;

    } else {

        fqdn = null;
        try {
            fqdn = require("fqdn");
            _fullyQualifiedDomainNameCache = fqdn() as string;
            if (/sethostname/.test(_fullyQualifiedDomainNameCache)) {
                _fullyQualifiedDomainNameCache = hostname();
            }

        } catch (err) {
            // fall back to old method
            _fullyQualifiedDomainNameCache = hostname();
        }

    }
    return trim(_fullyQualifiedDomainNameCache!, maxLength);
}
// note : under windows ... echo %COMPUTERNAME%.%USERDNSDOMAIN%
