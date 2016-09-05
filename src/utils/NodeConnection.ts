import * as cp from "child_process";
import NodeConnectionMessage from "../types/NodeConnectionMessage";
import NodeConnectionInterfaceSpec from "../types/NodeConnectionInterfaceSpec";

define((require, exports, module) => {

    const EventDispatcher = require("utils/EventDispatcher");
    const fork            = node.require("child_process").fork;
    const getLogger       = node.require("./utils").getLogger;
    const path            = node.require("path");
    const log             = getLogger("node-connection");

    const CONNECTION_TIMEOUT = 10000; // 10 seconds
    const MAX_COUNTER_VALUE = 4294967295; // 2^32 - 1

    function setDeferredTimeout(deferred: JQueryDeferred<any>, delay = CONNECTION_TIMEOUT) {
        const timer = setTimeout(() => deferred.reject("timeout"), delay);
        deferred.always(() => clearTimeout(timer));
    }

    function waitFor(condition: Function, delay = CONNECTION_TIMEOUT) {
        const deferred = $.Deferred();
        setDeferredTimeout(deferred, delay);
        // periodically check condition
        function doCheck() {
            return condition() ? deferred.resolve() : setTimeout(doCheck, 10);
        }
        doCheck();
        return deferred.promise();
    }

    class NodeConnection {

        /* eslint-disable */
        public domains: any; // TODO: better define structure
        public domainEvents: any; // TODO: better define structure
        private _autoReconnect: boolean;
        private _commandCount: number;
        private _name: string;
        private _nodeProcess: cp.ChildProcess | null;
        private _pendingCommandDeferreds: Array<JQueryDeferred<any>>;
        private _registeredDomains: { [domainPath: string]: {
            loaded: boolean,
            autoReload: boolean
        } };
        /* eslint-enable */

        constructor() {

            this.domains = {};
            this.domainEvents = {};
            this._registeredDomains = {
                // TODO: remove BaseDomain concept
                "./BaseDomain": { loaded: false, autoReload: false }
            };
            this._nodeProcess = null;
            this._pendingCommandDeferreds = [];
            this._name = "";
            this._commandCount = 1;
            this._autoReconnect = false;

        }

        public getName(): string {
            return this._name;
        }

        public connect(autoReconnect: boolean = false) {
            this._autoReconnect = autoReconnect;
            const deferred = $.Deferred();

            // Start the connection process
            this._cleanup();

            // Fork the process base as a child
            const nodeProcessPath = node.require.resolve("./node-process/base.js");
            this._nodeProcess = fork(nodeProcessPath);
            if (this._nodeProcess == null) {
                throw new Error(`Unable to fork ${nodeProcessPath}`);
            }

            this._nodeProcess.on("message", (obj: any) => {

                const _type: string = obj.type;
                switch (_type) {
                    case "log":
                        log[obj.level](`[node-process-${this.getName()}]`, obj.msg);
                        break;
                    case "receive":
                        this._receive(obj.msg);
                        break;
                    case "refreshInterface":
                        this._refreshInterfaceCallback(obj.spec);
                        break;
                    default:
                        log.warn(`unhandled message: ${JSON.stringify(obj)}`);
                }

            });

            // Called if we succeed at the final setup
            const success = () => {
                if (this._nodeProcess == null) {
                    throw new Error(`Unable to fork ${nodeProcessPath}`);
                }
                this._nodeProcess.on("disconnect", () => {
                    this._cleanup();
                    if (this._autoReconnect) {
                        (this as any).trigger("close", this.connect(true));
                    } else {
                        (this as any).trigger("close");
                    }
                });
                deferred.resolve();
            };

            // Called if we fail at the final setup
            const fail = (err: Error) => {
                this._cleanup();
                deferred.reject(err);
            };

            // refresh the current domains, then re-register any
            // "autoregister" modules

            // TODO: we shouldn't need to wait for BaseDomain, remove the concept
            waitFor(() => this.connected() && this._registeredDomains["./BaseDomain"].loaded === true).then(() => {
                const toReload = Object.keys(this._registeredDomains)
                    .filter(_path => this._registeredDomains[_path].autoReload === true);
                return toReload.length > 0 ?
                    this._loadDomains(toReload).then(success, fail) :
                    success();
            });

            this._refreshName();
            return deferred.promise();
        }

        public connected(): boolean {
            return !!(this._nodeProcess && this._nodeProcess.connected);
        }

        public disconnect() {
            this._autoReconnect = false;
            this._cleanup();
        }

        public loadDomains(paths: string | Array<string>, autoReload: boolean) {
            const pathArray: Array<string> = Array.isArray(paths) ? paths : [paths];

            pathArray.forEach(_path => {
                if (this._registeredDomains[_path]) {
                    throw new Error(`Domain path already registered: ${_path}`);
                }
                this._registeredDomains[_path] = {
                    loaded: false,
                    autoReload
                };
            });

            this._refreshName();
            return this._loadDomains(pathArray);
        }

        private _refreshName(): void {
            const domainPaths = Object.keys(this._registeredDomains);
            if (domainPaths.length > 1) {
                this._name = domainPaths.map(p => path.basename(p)).join(",");
            }
            if (this._nodeProcess) {
                this._name = this._nodeProcess.pid.toString();
            }
            this._name = "";
        }

        private _cleanup(): void {
            // shut down the old process if there is one
            if (this._nodeProcess) {
                try {
                    this._nodeProcess.kill();
                } finally {
                    this._nodeProcess = null;
                }
            }

            // clear out the domains, since we may get different ones on the next connection
            this.domains = {};

            // reject all the commands that are to be resolved
            this._pendingCommandDeferreds.forEach((d) => d.reject("cleanup"));
            this._pendingCommandDeferreds = [];

            this._refreshName();
        }

        private _getNextCommandID(): number {
            return this._commandCount > MAX_COUNTER_VALUE ?
                this._commandCount = 0 :
                this._commandCount++;
        }

        private _loadDomains(pathArray: string[]) {
            const deferred = $.Deferred();
            setDeferredTimeout(deferred, CONNECTION_TIMEOUT);

            // TODO: shouldn't need this, should call _loadDomains
            if (this.domains.base && this.domains.base.loadDomainModulesFromPaths) {
                this.domains.base.loadDomainModulesFromPaths(pathArray).then(
                    function (success: boolean) { // command call succeeded
                        if (!success) {
                            // response from commmand call was "false" so we know
                            // the actual load failed.
                            deferred.reject("loadDomainModulesFromPaths failed");
                        }
                        // if the load succeeded, we wait for the API refresh to
                        // resolve the deferred.
                    },
                    function (reason: string) { // command call failed
                        deferred.reject(
                            "Unable to load one of the modules: " + pathArray + (reason ? ", reason: " + reason : "")
                        );
                    }
                );
                waitFor(() => {
                    const loadedCount = pathArray
                        .map(_path => this._registeredDomains[_path].loaded)
                        .filter(x => x === true)
                        .length;
                    return loadedCount === pathArray.length;
                }).then(deferred.resolve);
            } else {
                deferred.reject("this.domains.base is undefined");
            }

            return deferred.promise();
        }

        private _send(m: NodeConnectionMessage) {
            if (this._nodeProcess && this.connected()) {

                // Convert the message to a string
                let messageString: string | null = null;
                if (typeof m === "string") {
                    messageString = m;
                } else {
                    try {
                        messageString = JSON.stringify(m);
                    } catch (stringifyError) {
                        log.error("Unable to stringify message in order to send: " + stringifyError.message);
                    }
                }

                // If we succeded in making a string, try to send it
                if (messageString) {
                    try {
                        this._nodeProcess.send({ type: "message", message: messageString });
                    } catch (sendError) {
                        console.error("[NodeConnection] Error sending message: " + sendError.message);
                    }
                }
            } else {
                console.error("[NodeConnection] Not connected to node, unable to send.");
            }
        }

        private _receive(messageString: string) {
            let responseDeferred: JQueryDeferred<any> | null = null;
            let ipcMessage: any;

            try {
                ipcMessage = JSON.parse(messageString);
            } catch (err) {
                console.error("[NodeConnection] received malformed message", messageString, err.message);
                return;
            }

            const message: NodeConnectionMessage = ipcMessage.message;

            switch (ipcMessage.type) {
                case "event":
                    if (message.domain === "base" && message.event === "newDomains") {
                        const newDomainPaths: string[] = message.parameters;
                        newDomainPaths.forEach((newDomainPath: string) => {
                            this._registeredDomains[newDomainPath].loaded = true;
                        });
                    }
                    // Event type "domain:event"
                    EventDispatcher.triggerWithArray(
                        this, message.domain + ":" + message.event, message.parameters
                    );
                    break;
                case "commandResponse":
                    responseDeferred = this._pendingCommandDeferreds[message.id];
                    if (responseDeferred) {
                        responseDeferred.resolveWith(this, [message.response]);
                        delete this._pendingCommandDeferreds[message.id];
                    }
                    break;
                case "commandProgress":
                    responseDeferred = this._pendingCommandDeferreds[message.id];
                    if (responseDeferred) {
                        responseDeferred.notifyWith(this, [message.message]);
                    }
                    break;
                case "commandError":
                    responseDeferred = this._pendingCommandDeferreds[message.id];
                    if (responseDeferred) {
                        responseDeferred.rejectWith(
                            this,
                            [message.message, message.stack]
                        );
                        delete this._pendingCommandDeferreds[message.id];
                    }
                    break;
                case "error":
                    console.error("[NodeConnection] received error: " + message.message);
                    break;
                default:
                    console.error("[NodeConnection] unknown event type: " + ipcMessage.type);
            }
        }

        private _refreshInterfaceCallback(spec: NodeConnectionInterfaceSpec) {
            const self = this;
            // TODO: move to prototype
            function makeCommandFunction(domain: string, command: string) {
                return function () {
                    const deferred = $.Deferred();
                    const parameters = Array.prototype.slice.call(arguments, 0);
                    const id = self._getNextCommandID();
                    self._pendingCommandDeferreds[id] = deferred;
                    self._send({
                        id,
                        domain,
                        command,
                        parameters
                    });
                    return deferred;
                };
            }
            this.domains = {};
            this.domainEvents = {};
            Object.keys(spec).forEach(function (domainKey) {
                const domainSpec = spec[domainKey];
                self.domains[domainKey] = {};
                Object.keys(domainSpec.commands).forEach(function (commandKey) {
                    self.domains[domainKey][commandKey] = makeCommandFunction(domainKey, commandKey);
                });
                self.domainEvents[domainKey] = {};
                Object.keys(domainSpec.events).forEach(function (eventKey) {
                    const eventSpec = domainSpec.events[eventKey];
                    const parameters = eventSpec.parameters;
                    self.domainEvents[domainKey][eventKey] = parameters;
                });
            });
        }

    }

    EventDispatcher.makeEventDispatcher(NodeConnection.prototype);

    module.exports = NodeConnection;

});
