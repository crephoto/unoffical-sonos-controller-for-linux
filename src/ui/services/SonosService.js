import _ from 'lodash';
import bb from 'bluebird';
import xml2json from 'jquery-xml2json';

import Search from '../sonos/Search';
import Listener from '../sonos/events/listener';

import Dispatcher from '../dispatcher/AppDispatcher';
import Constants from '../constants/Constants';

import ZoneGroupStore from '../stores/ZoneGroupStore';

const REG = /^http:\/\/([\d\.]+)/;
const SECOND_QUERY_TIMEOUT = 2000;

let SonosService = {

	_currentDevice: null,
	_queryTimeout: null,
	_deviceSearches: {},
	_listeners: {},
	_persistentSubscriptions: [],
	_currentSubscriptions: [],
	_searchInterval: null,
	_musicServices: [],

	mount () {
		this._searchInterval = window.setInterval(this.searchForDevices.bind(this), 1000);
		this.searchForDevices();
		this.restoreMusicServices();
	},

	searchForDevices () {
		let firstResultProcessed = false;

		new Search((sonos) => {

			bb.promisifyAll(sonos);

			if(this._searchInterval) {
				window.clearInterval(this._searchInterval);
			}

			let listener = new Listener(sonos);

			this._deviceSearches[sonos.host] = sonos;
			this._listeners[sonos.host] = listener;

			listener.listen(async (err) => {
				if (err) throw err;

				listener.onServiceEvent(this.onServiceEvent.bind(this));

				let persistSubscription = (err, sid) => {
					if(!err) {
						this._persistentSubscriptions.push({
							sid: sid,
							host: sonos.host,
							sonos: sonos,
						});
					}
				};

				// these events happen for all players
				listener.addService('/MediaRenderer/RenderingControl/Event', persistSubscription);
				listener.addService('/MusicServices/Event', persistSubscription);
				listener.addService('/MediaRenderer/AVTransport/Event', persistSubscription);
				listener.addService('/SystemProperties/Event', persistSubscription);

				this.queryCurrentTrackAndPlaystate(sonos)

				if(!firstResultProcessed) {
					this.queryTopology(sonos);
					this.queryAccounts(sonos);

					sonos.getHouseholdId((err, hhid) => {
						this.householdId = hhid;
					});
					listener.addService('/ZoneGroupTopology/Event', persistSubscription);
					firstResultProcessed = true;
				}
			});

		});
	},


	queryTopology (sonos) {

		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		let currentZone = ZoneGroupStore.getCurrent();
		let currentGroupMatch;

		sonos.getTopology((err, info) => {

			if(err) {
				return;
			}

			// find out whether current group still exists
			if(currentZone) {
				currentGroupMatch = _(info.zones).findWhere({
					group: currentZone.group
				});
			}

			if(!currentGroupMatch || !currentZone) {

				let zone = _(info.zones).reject({ name: "BRIDGE" }).reject({ name: "BOOST" }).findWhere({
					coordinator: "true"
				});

				if(window.localStorage.zone) {
					let match = _(info.zones).reject({ name: "BRIDGE" }).reject({ name: "BOOST" }).findWhere({
						uuid: window.localStorage.zone,
						coordinator: "true"
					});

					zone = match || zone;
				}

				//HACK: trying to prevent listener not having server throw, race condition?
				window.setTimeout(() => {
					this.selectCurrentZone(zone);

					Dispatcher.dispatch({
						actionType: Constants.SONOS_SERVICE_ZONEGROUPS_DEFAULT,
						zone: zone,
					});
				}, 500);

			}

			Dispatcher.dispatch({
				actionType: Constants.SONOS_SERVICE_TOPOLOGY_UPDATE,
				groups: this.excludeStereoPairs(info.zones),
			});
		});
	},

	queryVolumeInfo () {
		let zone = ZoneGroupStore.getCurrent();
		let topology = ZoneGroupStore.getAll();

		if(!zone) {
			return;
		}

		Object.keys(topology).forEach((key) => {
			let players = topology[key];

			players.forEach((m) => {

				if(m.group !== zone.group) {
					return;
				}

				let matches = REG.exec(m.location);
				let sonos = this._deviceSearches[matches[1]];

				sonos.getMuted((err, muted) => {
					if(err) {
						return;
					}
					sonos.getVolume((err, volume) => {
						if(err) {
							return;
						}
						Dispatcher.dispatch({
							actionType: Constants.SONOS_SERVICE_VOLUME_UPDATE,
							volume: volume,
							muted: muted,
							sonos: sonos,
						});
					});
				});
			});
		});
	},

	queryMusicLibrary (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		sonos.getMusicLibrary('queue', {}, (err, result) => {
			if(err) {
				return;
			}
			Dispatcher.dispatch({
				actionType: Constants.SONOS_SERVICE_QUEUE_UPDATE,
				result: result,
			});
		});
	},

	async queryCurrentTrackAndPlaystate (sonos) {

		try {
			let state = await sonos.getCurrentStateAsync()

			if(state === 'transitioning') {
				window.setTimeout(() => {
					this.queryCurrentTrackAndPlaystate(sonos);
				}, 1000);
				return;
			}

			let track = await sonos.currentTrackAsync();

			if(track.class === 'object.item') {
				let mediaInfo = await sonos.getMediaInfoAsync();

				let trackMeta = sonos.parseDIDL(xml2json(mediaInfo.CurrentURIMetaData, {
					explicitArray: true
				}));

				track = Object.assign(track, trackMeta);
			}

			Dispatcher.dispatch({
				actionType: Constants.SONOS_SERVICE_ZONEGROUP_TRACK_UPDATE,
				track: track,
				host: sonos.host,
				state: state,
			});

		} catch(e) {
			console.error(e);
		}

	},

	async queryCurrentTrack (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		try {
			let track = await sonos.currentTrackAsync();

			if(track.class === 'object.item') {
				let mediaInfo = await sonos.getMediaInfoAsync();

				let trackMeta = sonos.parseDIDL(xml2json(mediaInfo.CurrentURIMetaData, {
					explicitArray: true
				}));

				track = Object.assign(track, trackMeta);
			}

			if(this._currentDevice && sonos.host === this._currentDevice.host) {
				Dispatcher.dispatch({
					actionType: Constants.SONOS_SERVICE_CURRENT_TRACK_UPDATE,
					track: track,
					host: sonos.host,
				});
			}
		} catch (e) {
			console.error(e);
		}
	},

	queryPlayState (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		sonos.getCurrentState((err, state) => {
			if(err) {
				return;
			}
			this.processPlaystateUpdate(sonos, state);
		});
	},

	queryPositionInfo (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		// TODO: I should be able to do all of these in a promise based op
		// i.e. seek->getPosition
		sonos.getPositionInfo((err, info) => {
			if(err) {
				return;
			}

			if(this._currentDevice && sonos.host === this._currentDevice.host) {
				Dispatcher.dispatch({
					actionType: Constants.SONOS_SERVICE_POSITION_INFO_UPDATE,
					info: info,
				});
			}
		});
	},

	queryCrossfadeMode (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		let avTransport = new Services.AVTransport(sonos.host, sonos.port);

		avTransport.GetCrossfadeMode({
			InstanceID: 0,
		}, (err, info) => {
			if(err) {
				return;
			}

			if(this._currentDevice && sonos.host === this._currentDevice.host) {
				Dispatcher.dispatch({
					actionType: Constants.SONOS_SERVICE_CURRENT_CROSSFADE_MODE_UPDATE,
					info: Boolean(Number(info.CrossfadeMode)),
				});
			}
		});
	},

	async queryState (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		this.queryVolumeInfo();

		this.queryPositionInfo(sonos);
		this.queryMusicLibrary(sonos);
		this.queryCurrentTrack(sonos);
		this.queryPlayState(sonos);
		this.queryCurrentTrackAndPlaystate(sonos);
		this.queryCrossfadeMode(sonos);
	},

	queryAccounts (sonos) {
		sonos = sonos || this._currentDevice || _.first(this._deviceSearches);

		sonos.getAccountStatus((err, info) => {
			if(err) {
				return;
			}

			this._accountInfo = info;
		});
	},

	processPlaystateUpdate (sonos, state) {
		let publishState = (state) => {
			Dispatcher.dispatch({
				actionType: Constants.SONOS_SERVICE_PLAYSTATE_UPDATE,
				state: state,
				host: sonos.host,
			});
		};

		if(state === 'transitioning') {
			window.setTimeout(() => this.queryPlayState(sonos), 100);
		}

		publishState(state);
	},

	onServiceEvent (endpoint, sid, data) {

		switch (endpoint) {

			case '/SystemProperties/Event':
			case '/MusicServices/Event':
			case '/MediaRenderer/DeviceProperties/Event':
				console.log(endpoint, data);
				break;


			case '/ZoneGroupTopology/Event':
				{
					// Transform the message into the same format as sonos.getTopology
					let topology = xml2json(data.ZoneGroupState, {
						explicitArray: true
					});

					let zones = [];

					_.forEach(topology.ZoneGroups.ZoneGroup, (zg) => {
						let cId = zg.$.Coordinator;
						let gId = zg.$.ID;

						_.forEach(zg.ZoneGroupMember, (z) => {
							let zone = {};
							zone.group = gId;
							Object.keys(z.$).forEach((k) => {
								zone[String(k).toLowerCase()] = String(z.$[k]);
							});
							zone.name = zone.zonename;
							delete zone.zonename;


							if(cId === zone.uuid) {
								zone.coordinator = "true";
							}

							zones.push(zone);
						});
					});

					Dispatcher.dispatch({
						actionType: Constants.SONOS_SERVICE_TOPOLOGY_EVENT,
						groups: this.excludeStereoPairs(zones),
					});
				}
				break;

			case '/MediaRenderer/RenderingControl/Event':
				{
					let lastChange = xml2json(data.LastChange, {
						explicitArray: false
					});

					let subscription = _(this._persistentSubscriptions).findWhere({sid: sid});

					if(subscription) {
						Dispatcher.dispatch({
							actionType: Constants.SONOS_SERVICE_VOLUME_UPDATE,
							volume: Number(lastChange.Event.InstanceID.Volume[0].$.val),
							muted: Boolean(Number(lastChange.Event.InstanceID.Mute[0].$.val)),
							sonos: subscription.sonos,
						});
					}
				}
				break;

			case'/MediaRenderer/AVTransport/Event':
				{
					let lastChange = xml2json(data.LastChange);
					let subscription = _(this._persistentSubscriptions).findWhere({sid: sid});

					if(subscription) {
						let transportState = subscription.sonos.translateState(lastChange.Event.InstanceID.TransportState.$.val);

						let avTransportMetaDIDL = xml2json(lastChange.Event.InstanceID.AVTransportURIMetaData.$.val, {
							explicitArray: true
						});

						let currentTrackDIDL = xml2json(lastChange.Event.InstanceID.CurrentTrackMetaData.$.val, {
							explicitArray: true
						});

						Dispatcher.dispatch({
							actionType: Constants.SONOS_SERVICE_ZONEGROUP_TRACK_UPDATE,
							track: subscription.sonos.parseDIDL(currentTrackDIDL),
							avTransportMeta: this._currentDevice.parseDIDL(avTransportMetaDIDL),
							host: subscription.host,
							state: transportState,
						});

						if(this._currentDevice && subscription.host === this._currentDevice.host) {


							let currentPlayMode = lastChange.Event.InstanceID.CurrentPlayMode.$.val;
							let currentCrossfadeMode = Boolean(Number(lastChange.Event.InstanceID.CurrentCrossfadeMode.$.val));

							let nextTrackDIDL = xml2json(lastChange.Event.InstanceID['r:NextTrackMetaData'].$.val, {
								explicitArray: true
							});

							Dispatcher.dispatch({
								actionType: Constants.SONOS_SERVICE_CURRENT_TRACK_UPDATE,
								track: this._currentDevice.parseDIDL(currentTrackDIDL),
								avTransportMeta: this._currentDevice.parseDIDL(avTransportMetaDIDL),
							});

							Dispatcher.dispatch({
								actionType: Constants.SONOS_SERVICE_CURRENT_PLAY_MODE_UPDATE,
								mode: currentPlayMode,
							});

							Dispatcher.dispatch({
								actionType: Constants.SONOS_SERVICE_CURRENT_CROSSFADE_MODE_UPDATE,
								mode: currentCrossfadeMode,
							});

							Dispatcher.dispatch({
								actionType: Constants.SONOS_SERVICE_NEXT_TRACK_UPDATE,
								track: this._currentDevice.parseDIDL(nextTrackDIDL),
							});

							this.processPlaystateUpdate(subscription.sonos, transportState);
						}
					}
				}
				break;

			case '/MediaServer/ContentDirectory/Event':
				{
					this.queryMusicLibrary();
				}
				break;
		}
	},

	subscribeServiceEvents (sonos) {
		let x = this._listeners[sonos.host];

		let cb = (error, sid) => {
			if (error) throw error;
			this._currentSubscriptions.push(sid);
		};

		x.addService('/MediaRenderer/GroupRenderingControl/Event', cb);
		x.addService('/MediaServer/ContentDirectory/Event', cb);
	},


	unsubscribeServiceEvents (sonos) {
		let x = this._listeners[sonos.host];

		this._currentSubscriptions.forEach((sid) => {
			x.removeService(sid, (error) => {
				if (error) throw error;
				console.log('Successfully unsubscribed');
			});
		});

		this._currentSubscriptions = [];
	},

	selectCurrentZone (value) {
		let sonos;

		let matches = REG.exec(value.location);
		sonos = this._deviceSearches[matches[1]];

		if(sonos === this._currentDevice) {
			this.queryState(sonos);
			return;
		}

		window.localStorage.zone = value.uuid;

		if(sonos) {
			if(this._currentDevice) {
				this.unsubscribeServiceEvents(this._currentDevice);
			}

			if(this._queryTimeout) {
				window.clearTimeout(this._queryTimeout);
			}

			this._currentDevice = sonos;

			this.subscribeServiceEvents(sonos);
			this.queryState(sonos);
			this._queryTimeout = window.setTimeout(() =>  this.queryState(), SECOND_QUERY_TIMEOUT);
		}
	},

	excludeStereoPairs (zones) {

		// TODO: find a better place for this
		zones.forEach((z) => {
			let matches = REG.exec(z.location);
			z.host = matches[1];
		});

		return _(zones).groupBy('name').map((g) => {
			// TODO: what happens when a sub is added?
			if(g.length === 2) {
				g[0].name = g[0].name + ' (L + R)';
			}
			return _.findWhere(g, { 'coordinator': 'true' }) || g[0];
		}).value();
	},

	rememberMusicService (service, authToken) {
		this._musicServices.push({
			service: service,
			authToken: authToken,
		});

		return new Promise((resolve, reject) => {

			window.localStorage.musicServices = JSON.stringify(this._musicServices);

			Dispatcher.dispatch({
				actionType: Constants.SONOS_SERVICE_MUSICSERVICES_UPDATE,
				musicServices: this._musicServices,
			});

			resolve();
		});
	},

	removeMusicService (service) {
		let currentServices = JSON.parse(window.localStorage.musicServices);

		currentServices = _.reject(currentServices, (s) => {
			return s.service.Id == service.Id;
		});

		window.localStorage.musicServices = JSON.stringify(currentServices);
		this._musicServices = currentServices;

		Dispatcher.dispatch({
			actionType: Constants.SONOS_SERVICE_MUSICSERVICES_UPDATE,
			musicServices: this._musicServices,
		});
	},

	restoreMusicServices () {
		this._musicServices = window.localStorage.musicServices ? JSON.parse(window.localStorage.musicServices) : [];

		Dispatcher.dispatch({
			actionType: Constants.SONOS_SERVICE_MUSICSERVICES_UPDATE,
			musicServices: this._musicServices,
		});
	}
};

window.SonosService = SonosService;
export default SonosService;
