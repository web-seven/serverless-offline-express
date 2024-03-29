'use strict';

const express = require('express');
const webpack = require('webpack');
const BbPromise = require('bluebird');
const webpackConfig = require('../webpack.config');

class OfflineExpress {

    constructor(serverless, options) {
        this.serverless = serverless;
        this.service = serverless.service;
        this.serverlessLog = serverless.cli.log.bind(serverless.cli);
        this.options = options;
        this.chunksHashes = {};
        this.exitCode = 0;

        this.commands = {
            express: {
                usage: 'Running offline multiple Express request/response based Serverless functions',
                lifecycleEvents: ['start']
            }
        };

        this.hooks = {
            'express:before:start': BbPromise.resolve(),
            'express:start': this.start.bind(this),
        };
    }

    async buildServer() {
        var me = this;
        webpackConfig.entry = () => {
            var entries = {};
            this.serverless.service.getAllFunctions().forEach((functionName) => {
                var functionObject = this.serverless.service.getFunction(functionName);
                var functionBasePath = './' + functionObject.handler.split('.')[0];
                entries[functionName] = functionBasePath;
            });
            return entries;
        }

        var app = express();

        webpack(webpackConfig).watch({}, (err, stats) => {
            if (err !== null) {
                console.log('WEBPACK ERROR:', err);
            }
            stats.toJson().chunks.forEach((chunk) => {

                if (me.chunksHashes[chunk.id] !== undefined && me.chunksHashes[chunk.id] === chunk.hash) {
                    return true;
                }

                var handlerFile = webpackConfig.output.path + '/' + chunk.files[0];
                delete require.cache[handlerFile];
                var handler = require(handlerFile);

                var functionName = chunk.names[0];
                var functionObject = this.serverless.service.getFunction(functionName);
                var handlerFunctionName = functionName;
                if (functionObject.handler.includes('.')) {
                    handlerFunctionName = functionObject.handler.split('.')[1];
                }
                functionObject.events.forEach((event) => {
                    if (event && (typeof event.http === 'object' || typeof event.pubsub === 'object')) {
                        var method = 'get';
                        var path = '/';

                        if (typeof event.http === 'object') {
                            if (typeof event.http.method === 'string') {
                                method = event.http.method.toLowerCase();
                                if (method === '*') {
                                    method = 'all';
                                }
                            }
                            if (typeof event.http.path === 'string') {
                                path += event.http.path;
                            }
                        }

                        if (typeof event.pubsub === 'object') {
                            path = '/pubsub/';
                            if (typeof event.pubsub.topic === 'string') {
                                path += event.pubsub.topic;
                            } else {
                                return true;
                            }
                        }

                        if (app._router) {
                            var routes = app._router.stack;
                            routes.forEach((layer, index) => {
                                if (layer.route !== undefined && layer.route.path === path) {
                                    this.serverlessLog('Remove previous version of function:' + functionName);
                                    routes.splice(index, 1);
                                }
                            })
                        }

                        this.serverlessLog('Assign function:' + functionName + ' to ' + method.toUpperCase() + ' ' + path);

                        if (typeof event.http === 'object') {
                            app[method](path, handler[handlerFunctionName]);
                        }

                        if (typeof event.pubsub === 'object') {
                            app.get(path, (request, response) => {
                                var handlerFunction = handler[handlerFunctionName];
                                if (typeof request.query.message === 'undefined'
                                    && typeof request.query.attributes === 'undefined') {
                                    return response.send('Message or Attributes not provided.');
                                }

                                var pubSubMessage = request.query.message;

                                var toJSON = () => {
                                    var result = {}
                                    try {
                                        result = JSON.parse(pubSubMessage);
                                    } catch (error) {
                                        result = {}
                                    }
                                    return result;
                                };

                                var message = {
                                    attributes: request.query.attributes,
                                    data: Buffer.from(pubSubMessage).toString('base64'),
                                    json: toJSON(),
                                    toJSON: toJSON
                                };
                                var context = {
                                    timestamp: new Date().getTime(),
                                    eventId: new Date().getTime()
                                }
                                response.send(handlerFunction(message, context));
                            });
                        }

                        me.chunksHashes[chunk.id] = chunk.hash

                    }
                })
            });
        });

        return app;
    }

    async start() {
        process.env.IS_OFFLINE = true;
        const PORT = (process.env.EXPRESS_PORT) ? process.env.EXPRESS_PORT : 3000;
        const HOST = (process.env.EXPRESS_HOST) ? process.env.EXPRESS_HOST : 'localhost';
        var server = await this.buildServer();
        var logger = this.serverlessLog;
        server.listen(PORT, function () {
            logger('Express started at http://' + HOST + ':' + PORT);
        })
        return new Promise(() => { });
    }

    end() {
    }

}
process.removeAllListeners('unhandledRejection');

module.exports = OfflineExpress;
