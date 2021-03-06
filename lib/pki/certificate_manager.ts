// ---------------------------------------------------------------------------------------------------------------------
// node-opcua
// ---------------------------------------------------------------------------------------------------------------------
// Copyright (c) 2014-2018 - Etienne Rossignon - etienne.rossignon (at) gadz.org
// ---------------------------------------------------------------------------------------------------------------------
//
// This  project is licensed under the terms of the MIT license.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so,  subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// ---------------------------------------------------------------------------------------------------------------------
// tslint:disable:no-shadowed-variable
// tslint:disable:member-ordering

import * as assert from "assert";
import * as async from "async";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as _ from "underscore";

import {Certificate, exploreCertificateInfo, makeSHA1Thumbprint, readCertificate, toPem} from "node-opcua-crypto";

import {
    configurationFileSimpleTemplate,
    createCertificateSigningRequest,
    createPrivateKey,
    createSelfSignCertificate,
    debugLog,
    ensure_openssl_installed,
    make_path,
    mkdir,
    Params,
    setEnv
} from "./toolbox";

import {CertificateStatus, ErrorCallback, KeySize, Thumbprint} from "./common";

// tslint:disable-next-line:no-var-requires
const walk = require("walk");

export interface CertificateManagerOptions {
    keySize?: KeySize;
    location: string;
}

export class CertificateManager {

    private keySize: KeySize;
    private location: string;
    private _thumbs: {
        rejected: { [key: string]: any },
        trusted: { [key: string]: any },
    };

    constructor(options: CertificateManagerOptions) {
        options.keySize = options.keySize || 2048;
        assert(options.hasOwnProperty("location"));
        assert(options.hasOwnProperty("keySize"));

        this.location = make_path(options.location, "");
        this.keySize = options.keySize;

        mkdir(options.location);

        // istanbul ignore next
        if (!fs.existsSync(this.location)) {
            throw new Error("CertificateManager cannot access location " + this.location);
        }
        this._thumbs = {
            rejected: {},
            trusted: {},
        };
    }

    get configFile() {
        return path.join(this.rootDir, "own/openssl.cnf");
    }

    get rootDir() {
        return this.location;
    }

    get privateKey() {
        return path.join(this.rootDir, "own/private/private_key.pem");
    }

    get randomFile() {
        return path.join(this.rootDir, "own/private/random.rnd");
    }

    public async getCertificateStatus(certificate: Buffer): Promise<CertificateStatus>;
    public getCertificateStatus(certificate: Buffer,
                                callback: (err: Error | null, status?: CertificateStatus) => void): void;
    public getCertificateStatus(certificate: Buffer, ...args: any[]): any {

        const callback = args[0] as (err: Error | null, status?: CertificateStatus) => void;

        this.initialize(() => {

            this._getCertificateStatus(
                certificate,
                (err: Error | null, status?: CertificateStatus) => {
                    if (err) {
                        return callback(err);
                    }
                    if (status === "unknown") {
                        assert(certificate instanceof Buffer);
                        const thumbprint = makeSHA1Thumbprint(certificate).toString("hex");
                        const certificateName = path.join(this.rootDir, "rejected", thumbprint + ".pem");

                        const pem = toPem(certificate, "CERTIFICATE");
                        fs.writeFile(certificateName, pem, (err?: Error) => {
                            if (err) {
                                return callback(err);
                            }
                            status = "rejected";
                            return callback(null, status);
                        });
                        return;
                    }
                    return callback(null, status);
                });
        });
    }

    public async rejectCertificate(certificate: Certificate): Promise<void>;
    public rejectCertificate(certificate: Certificate, callback: ErrorCallback): void;
    public rejectCertificate(certificate: Certificate, ...args: any[]): any {
        const callback = args[0];
        this._moveCertificate(certificate, "rejected", callback);
    }

    public async trustCertificate(certificate: Certificate): Promise<void>;
    public trustCertificate(certificate: Certificate, callback: ErrorCallback): void;
    public trustCertificate(certificate: Certificate, ...args: any[]): any {
        const callback = args[0];
        this._moveCertificate(certificate, "trusted", callback);
    }

    /**
     * Verify certificate validity
     * @method verifyCertificate
     * @param certificate
     * @param callback
     */
    public verifyCertificate(certificate: Certificate, callback: ErrorCallback) {

        // Is the  signature on the SoftwareCertificate valid .?
        if (!certificate) {
            // missing certificate
            return callback(new Error("BadSecurityChecksFailed"));
        }
        // -- var split_der = require("lib/misc/crypto_explore_certificate").split_der;
        // -- var chain = split_der(securityHeader.senderCertificate);
        // -- //xx console.log("xxx NB CERTIFICATE IN CHAIN = ".red,chain.length);

        // Has SoftwareCertificate passed its issue date and has it not expired ?
        // check dates
        const cert = exploreCertificateInfo(certificate);
        const now = new Date();

        async.series([
            // check that certificate is active
            (callback: ErrorCallback) => {
                if (cert.notBefore.getTime() > now.getTime()) {
                    // certificate is not active yet
                    debugLog(chalk.red("certificate is invalid : certificate is not active yet !") +
                        "  not before date =" + cert.notBefore);
                    return callback(new Error("BadCertificateTimeInvalid"));
                } else {
                    return callback();
                }
            },

            //  check that certificate has not expired
            (callback: ErrorCallback) => {
                if (cert.notAfter.getTime() <= now.getTime()) {
                    // certificate is obsolete
                    debugLog(chalk.red("certificate is invalid : certificate has expired !")
                        + " not after date =" + cert.notAfter);
                    return callback(new Error("BadCertificateTimeInvalid"));
                } else {
                    return callback();
                }
            },
            // check that certificate is not untrusted
            (callback: ErrorCallback) => {

                this._getCertificateStatus(certificate, (err: Error | null, status?: CertificateStatus) => {

                    // istanbul ignore next
                    if (err) {
                        return callback(err);
                    }

                    if (status === "rejected") {
                        return callback(new Error("BadCertificateUntrusted"));
                    } else if (status === "trusted") {
                        return callback(); // OK
                    }
                    assert(status === "unknown");
                    return callback(new Error("BadCertificateUntrusted"));

                });
            },
            // _check_that_certificate_has_not_been_revoked_by_issuer
            (callback: ErrorCallback) => {
                // Has SoftwareCertificate has  been revoked by the issuer ?
                // TODO: check if certificate is revoked or not ...
                // BadCertificateRevoked
                return callback();
            },
            // check that issuer certificate has not been revoked by the CA authority
            (callback: ErrorCallback) => {
                // is issuer Certificate valid and has not been revoked by the CA that issued it. ?
                // TODO : check validity of issuer certificate
                // StatusCodes.BadCertificateIssuerRevoked
                return callback();
            },
            // check that ApplicationDescription matches URI in certificate
            (callback: ErrorCallback) => {
                // does the URI specified in the ApplicationDescription  match the URI in the Certificate ?
                // TODO : check ApplicationDescription of issuer certificate
                // return StatusCodes.BadCertificateUriInvalid
                return callback();
            }
        ], callback);
    }

    /*
     *
     *  PKI
     *    +---> trusted
     *    +---> rejected
     *    +---> own
     *           +---> cert
     *           +---> own
     *
     */
    public async initialize(): Promise<void>;
    public initialize(callback: (err?: Error) => void): void;
    public initialize(...args: any[]): any {

        const callback = args[0];

        const pkiDir = this.location;
        mkdir(pkiDir);
        mkdir(path.join(pkiDir, "own"));
        mkdir(path.join(pkiDir, "own/certs"));
        mkdir(path.join(pkiDir, "own/private"));
        mkdir(path.join(pkiDir, "trusted"));
        mkdir(path.join(pkiDir, "rejected"));

        ensure_openssl_installed(() => {
            // if (1 || !fs.existsSync(this.configFile)) {
            //    var data = toolbox.configurationFileTemplate;
            //    data = data.replace(/%%ROOT_FOLDER%%/, toolbox.make_path(pkiDir,"own"));
            //    fs.writeFileSync(this.configFile, data);
            // }
            //

            fs.writeFileSync(this.configFile, configurationFileSimpleTemplate);

            fs.exists(this.privateKey, (exists: boolean) => {
                if (!exists) {
                    debugLog("generating private key ...");
                    setEnv("RANDFILE", this.randomFile);
                    createPrivateKey(this.privateKey, this.keySize, (err?: Error) => {
                        return callback(err);
                    });
                } else {
                    debugLog("private key already exists ... skipping");
                    return callback();
                }
            });
        });
    }

    /**
     *
     * create a self-signed certificate for the CertificateManager private key
     *
     *
     * @param params
     * @param params.applicationUri   the application URI
     * @param params.altNames  array of alternate names
     * @param [params.outputFile="own/certs/self_signed_certificate.pem"]
     * @param params.subject
     * @param params.subject.commonName
     * @param params.subject.organization
     * @param params.subject.organizationUnit
     * @param params.subject.locality
     * @param params.subject.state
     * @param params.subject.country
     * @param params.validity
     * @param params.dns
     * @param params.ip
     */
    public async createSelfSignedCertificate(
        params: Params,
    ): Promise<void>;
    public createSelfSignedCertificate(
        params: Params,
        callback: ErrorCallback
    ): void;
    public createSelfSignedCertificate(
        params: Params,
        ...args: any[]
    ): any {
        const callback = args[0];
        const self = this;
        assert(_.isString(params.applicationUri));
        if (!fs.existsSync(self.privateKey)) {
            return callback(new Error("Cannot find private key " + self.privateKey));
        }

        let certificateFilename = path.join(self.rootDir, "own/certs/self_signed_certificate.pem");
        certificateFilename = params.outputFile || certificateFilename;

        params.rootDir = self.rootDir;
        params.configFile = self.configFile;
        params.privateKey = self.privateKey;

        createSelfSignCertificate(certificateFilename, params, callback);
    }

    public createCertificateRequest(
        params: Params,
        callback: (err: Error | null, certificateSigningRequestFilename?: string) => void
    ) {

        assert(_.isFunction(callback));

        if (params.rootDir) {
            throw new Error("rootDir should not be specified " + params.rootDir);
        }
        assert(params);
        assert(!params.rootDir);
        assert(!params.configFile);
        assert(!params.privateKey);
        params.rootDir = this.rootDir;
        params.configFile = this.configFile;
        params.privateKey = this.privateKey;

        // compose a file name for the request
        const now = new Date();
        const today = now.toISOString().slice(0, 10) + "_" + now.getTime();
        const certificateSigningRequestFilename = path.join(
            params.rootDir,
            "own/certs", "certificate_" + today + ".csr");

        // xx toolbox.processAltNames(params);
        createCertificateSigningRequest(
            certificateSigningRequestFilename,
            params,
            (err?: Error) => {
                return callback(err!, certificateSigningRequestFilename);
            });
    }

    /**
     * @internal
     * @param certificate
     * @param callback
     * @private
     */
    public _getCertificateStatus(
        certificate: Certificate,
        callback: (err: Error | null, status?: CertificateStatus) => void
    ) {

        assert(certificate instanceof Buffer);
        const thumbprint = makeSHA1Thumbprint(certificate).toString("hex");

        debugLog("thumbprint ", thumbprint);

        this._readCertificates((err?: Error) => {
            if (err) {
                return callback(err);
            }
            if (this._thumbs.rejected.hasOwnProperty(thumbprint)) {
                return callback(null, "rejected");
            }
            if (this._thumbs.trusted.hasOwnProperty(thumbprint)) {
                return callback(null, "trusted");
            }
            return callback(null, "unknown");
        });

    }

    private _moveCertificate(
        certificate: Buffer,
        newStatus: CertificateStatus,
        callback: ErrorCallback
    ) {

        assert(certificate instanceof Buffer);
        const thumbprint = makeSHA1Thumbprint(certificate).toString("hex");

        this.getCertificateStatus(certificate, (err: Error | null, status?: CertificateStatus) => {
            if (err) {
                return callback(err);
            }

            if (status !== newStatus) {
                const certificateSrc = path.join(this.rootDir, status!, thumbprint + ".pem");
                const certificateDest = path.join(this.rootDir, newStatus, thumbprint + ".pem");

                fs.rename(certificateSrc, certificateDest, (err?: Error) => {

                    delete (this._thumbs as any)[status!][thumbprint];
                    (this._thumbs as any)[newStatus][thumbprint] = 1;
                    return callback(err);
                });

            } else {
                return callback();
            }
        });
    }

    private _readCertificates(callback: (err?: Error) => void) {
        function readThumbprint(certificateFilename: string): Thumbprint {
            const certificate = readCertificate(certificateFilename);
            //noinspection UnnecessaryLocalVariableJS
            const thumbprint = makeSHA1Thumbprint(certificate).toString("hex");
            return thumbprint as Thumbprint;
        }

        function _f(folder: string, index: any, callback: (err?: Error) => void) {

            const walker = walk.walk(folder, {followLinks: false});

            walker.on("file", (root: string, stat: any, next: () => void) => {

                const filename = path.join(root, stat.name);
                const thumbprint = readThumbprint(filename);
                index[thumbprint] = 1;
                next();
            });
            walker.on("end", () => {
                return callback();
            });
        }

        async.series([
            (callback: (err?: Error) => void) => {
                _f.bind(this, path.join(this.rootDir, "trusted"), this._thumbs.trusted)
                    .call(null, callback);
            },
            (callback: (err?: Error) => void) => {
                _f.bind(this, path.join(this.rootDir, "rejected"), this._thumbs.rejected)
                    .call(null, callback);
            }
        ], (err) => callback(err!));
    }
}

// tslint:disable:no-var-requires
// tslint:disable:max-line-length
const thenify = require("thenify");
const opts = {multiArgs: false};
CertificateManager.prototype.rejectCertificate = thenify.withCallback(CertificateManager.prototype.rejectCertificate, opts);
CertificateManager.prototype.trustCertificate = thenify.withCallback(CertificateManager.prototype.trustCertificate, opts);
CertificateManager.prototype.createSelfSignedCertificate = thenify.withCallback(CertificateManager.prototype.createSelfSignedCertificate, opts);
CertificateManager.prototype.initialize = thenify.withCallback(CertificateManager.prototype.initialize, opts);
CertificateManager.prototype.getCertificateStatus = thenify.withCallback(CertificateManager.prototype.getCertificateStatus, opts);
