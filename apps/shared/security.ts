import { secureHeaders } from "hono/secure-headers";

const securityHeaders = (connectSrc: string[]) =>
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://www.gravatar.com"],
      connectSrc,
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  });

export const httpSecurity = securityHeaders(["'self'"]);
export const webSecurity = (apiOrigin: string) =>
  securityHeaders(["'self'", apiOrigin]);
