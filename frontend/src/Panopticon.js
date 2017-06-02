import React, { Component } from 'react';
import _ from 'lodash';
import M from 'mobx';
import moment from 'moment';
import {observer, Provider} from 'mobx-react';
import WSClient from './wsclient';
import {MasterStateStore} from './MasterStateStore';
import {MasterView} from './MasterView';

let match = window.location.search.slice(1).match(/^(\w+)-(\w+)$/);
let panopt = match[1], panopticode = match[2];

var ws = new WSClient(`ws://${window.location.host}/ws`);
ws.setHello([{type: 'init', participantId: panopticode, kind: panopt}]);
ws.connect();

// Logs are not observable, for minimal overhead.
var logs = {};

export class PanoptStore {
  constructor(clientId, kind) {
    M.extendObservable(this, {
      showingIds: [],
      states: M.asMap({}),
      startTimes: M.asMap({}),
      times: M.asMap({}),
      acceleration: 10,
    });
  }

  addViewer = M.action((id) => {
    if (this.showingIds.indexOf(id) !== -1) return; // Already a viewer.
    this.showingIds.push(id);
    if (!this.states.has(id)) {
      this.states.set(id, new MasterStateStore(id));
      ws.send({type: 'get_logs', participantId: id});
    }
  });

  addViewers = M.action((ids) => {
    ids.forEach(id => this.addViewer(id))
  })
}

var store = new PanoptStore();
var requestTimes = {};
var rtts = [];
window.rtts = rtts;

function replay(log, state) {
  if (log.length === 0) return;
  let idx = 0;
  function tick() {
    let event = log[idx];
    let toLog = {...event};
    delete toLog.participant_id;
    delete toLog.timestamp;
    delete toLog.kind;
    delete toLog.jsTimestamp;
    // console.log(toLog);
    try {
      state.handleEvent(event);
    } catch (e) {
      console.error("Exception while handling event", event, e.message);
    }
    if (event.type === 'receivedSuggestions') {
      let rtt = event.jsTimestamp - requestTimes[event.participant_id][event.msg.request_id];
      // if (_.isNaN(rtt)) debugger;
      if (rtt) {
        rtts.push(rtt);
      }
      console.log('rtt', rtt);
    }
    if (idx === log.length - 1) return;
    setTimeout(tick, Math.min(1000, (log[idx + 1].jsTimestamp - log[idx].jsTimestamp) / store.acceleration));
    idx++;
  }
  tick();
}


function trackRtts(participantId) {
  // Mimic the autorunner
  let state = store.states.get(participantId);
  let times = (requestTimes[participantId] = {});

  // Auto-runner to watch the context and request suggestions.
  M.autorun(() => {
    let {suggestionRequest} = state;
    if (!suggestionRequest) {
      return;
    }

    // If we get here, we would have made a request.
    M.untracked(() => {
      if (suggestionRequest.request_id === 0) {
        times = requestTimes[participantId] = {};
      }
      // if (suggestionRequest.request_id in times) debugger;
      times[suggestionRequest.request_id] = state.lastEventTimestamp;
    });

  });
}

ws.onmessage = function(msg) {
  if (msg.type === 'logs') {
    let participantId = msg.participant_id;
    logs[participantId] = msg.logs;
    let state = store.states.get(participantId);
    trackRtts(participantId);
    replay(msg.logs, state);
    state.replaying = false;
    // store.startTimes.set(participantId, msg.logs[0].jsTimestamp);
    // state.replaying = true;
    // logs[participantId].forEach(msg => {
    //   state.handleEvent(msg);
    // });
    // state.replaying = false;
  }
};

const nullDispatch = () => {};

const ScreenTimesTable = ({state}) => {
  let lastTime = null;
  let durs = [];
  state.screenTimes.forEach(({timestamp}) => {
    let curTime = moment(timestamp);
    if (lastTime !== null) {
      durs.push(curTime.diff(lastTime, 'minutes', true));
    }
    lastTime = curTime;
  });
  return <table>
    <tbody>
      {state.screenTimes.map(({num, timestamp}, i) => {
        let curTime = moment(timestamp);
        let dur = i < durs.length ? `${Math.round(10 * durs[i]) / 10} min` : null;
        return <tr key={num}><td>{state.screens[num].controllerScreen || state.screens[num].screen}</td><td>{curTime.format('LTS')}</td><td>{dur}</td></tr>;
      })}
    </tbody>
  </table>;
}

const Panopticon = observer(class Panopticon extends Component {
  render() {
    return <div>{store.showingIds.map(participantId => {
      let state = store.states.get(participantId);
      if (!state.masterConfig) return null;
      return <div key={participantId}>
        <h1>{participantId} {state.conditions.join(',')}</h1>
        <div style={{display: 'flex', flexFlow: 'row'}}>
          <div style={{overflow: 'hidden', width: state.phoneSize.width, height: state.phoneSize.height, border: '1px solid black', flex: '0 0 auto'}}>
            <Provider state={state} dispatch={nullDispatch} clientId={participantId} clientKind={'p'} spying={true}>
              <MasterView kind={'p'}/>
            </Provider>
          </div>
          <div style={{overflow: 'hidden', width: 450, height: 500, border: '1px solid black', flex: '0 0 auto'}}>
            <Provider state={state} dispatch={nullDispatch} clientId={participantId} clientKind={'c'} spying={true}>
              <MasterView kind={'c'} />
            </Provider>
          </div>
          <div style={{flex: '0 0 auto'}}>
            <ScreenTimesTable state={state} />
          </div>
          <div style={{flex: '1 1 auto'}}>
            {state.experiments.entries().map(([name, expState]) => <div key={name}>
              <b>{name}</b><br/>{expState.curText}</div>)}
          </div>
        </div>
      </div>;
    })}</div>;
  }
});

export default Panopticon;

// Globals
window.M = M;
window.store = store;
