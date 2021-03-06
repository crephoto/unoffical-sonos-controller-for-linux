import _ from 'lodash';

import withinEnvelope from '../helpers/withinEnvelope';
import xml2js from '../helpers/xml2js';
import request from '../helpers/request';

class Service {
    constructor(options) {
        this.name = options.name;
        this.host = options.host;
        this.port = options.port || 1400;
        this.controlURL = options.controlURL;
        this.eventSubURL = options.eventSubURL;
        this.SCPDURL = options.SCPDURL;
    }

    _request(action, variables, callback) {
        const message_action =
            '"urn:schemas-upnp-org:service:' + this.name + ':1#' + action + '"';
        const message_body_pre =
            '<u:' +
            action +
            ' xmlns:u="urn:schemas-upnp-org:service:' +
            this.name +
            ':1">';
        const message_body_post = '</u:' + action + '>';
        const message_body =
            message_body_pre +
            _.map(variables, function(value, key) {
                return '<' + key + '>' + value + '</' + key + '>';
            }).join('') +
            message_body_post;
        const responseTag = 'u:' + action + 'Response';

        request(
            {
                uri: 'http://' + this.host + ':' + this.port + this.controlURL,
                method: 'POST',
                headers: {
                    SOAPAction: message_action,
                    'Content-type': 'text/xml; charset=utf8'
                },
                body: withinEnvelope(message_body)
            },
            function(err, res, body) {
                if (err) {
                    return callback(err);
                }

                new xml2js.Parser().parseString(body, function(err, json) {
                    if (err) {
                        return callback(err);
                    }

                    if (!json['s:Envelope']) {
                        callback('Body undefined', null);
                        return;
                    }

                    if (
                        typeof json['s:Envelope']['s:Body'][0]['s:Fault'] !==
                        'undefined'
                    ) {
                        return callback(
                            new Error(
                                json['s:Envelope']['s:Body'][0]['s:Fault'][0]
                                    .faultstring[0] +
                                    ': ' +
                                    json['s:Envelope']['s:Body'][0][
                                        's:Fault'
                                    ][0].detail[0].UPnPError[0].errorCode[0]
                            )
                        );
                    }

                    const output =
                        json['s:Envelope']['s:Body'][0][responseTag][0];
                    delete output.$;
                    _.each(output, function(item, key) {
                        output[key] = item[0];
                    });
                    return callback(null, output);
                });
            }
        );
    }
}

export default Service;
