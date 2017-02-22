import React, { Component } from 'react';
import _ from 'lodash';
import M from 'mobx';
// unused: observable, action, toJS, transaction
import {observer, inject, Provider} from 'mobx-react';
import WSClient from './wsclient';
import {Keyboard} from './Keyboard';
import {MasterStateStore} from './MasterStateStore';

//var ws = new WSClient(`ws://${process.env.REACT_APP_BACKEND_HOST}:${process.env.REACT_APP_BACKEND_PORT}/ws`);
var ws = new WSClient(`ws://${window.location.host}/ws`);

// Generate a hopefully-unique id
var clientId = (function() {
  if (window.location.search === '?reset') {
    localStorage.clear();
    window.location.search = '';
  } else if (window.location.search.match(/^\?\d{6}$/)) {
    return window.location.search.slice(1);
  }
  if (window.localStorage.getItem('clientId')) {
    return window.localStorage.getItem('clientId');
  }
  return _.range(6).map(function(i) { return _.sample('0123456789abcdef'); }).join('');
})();
window.localStorage['clientId'] = clientId;
ws.sendHello({type: 'init', participantId: clientId});


/**** Event dispatching

This is how we split the difference between Flux everything-is-a-big-global-action and mobx just-mutate-stuff:
All input comes in as events represented as plain JSON objects. The level of interpretation should be pragmatic:
low-level enough to be able to get fine-grained detail about what happened, but high-level enough to be able
to read off interesting things without much work. e.g., for a key tap, include the tap x/y position, but also
what key we thought it was.

All server communication comes in this way too.
 */

var eventHandlers = [];
var dispatchDisabled = false;

function registerHandler(fn) {
  eventHandlers.push(fn);
}

function dispatch(event) {
  if (dispatchDisabled) {
    console.warn("Skipping event because dispatch disabled:", event);
    return;
  }
  console.log(event);
  log(event);
  event.timestamp = +new Date();
  eventHandlers.forEach(fn => fn(event));
}

// Every event gets logged to the server. Keep events small!
function log(event) {
  ws.send({type: 'log', event});
}


var state = new MasterStateStore(clientId);
registerHandler(state.handleEvent);


function startRequestingSuggestions() {
  // Auto-runner to watch the context and request suggestions.
  M.autorun(() => {
    let {experimentState} = state;
    if (!experimentState)
      return;

    let seqNum = experimentState.contextSequenceNum;

    // Abort if we already have the suggestions for this context.
    if (experimentState.lastSuggestionsFromServer.length > 0 &&
        experimentState.lastSuggestionsFromServer[0].contextSequenceNum === seqNum)
      return;

    // The only dependency is contextSequenceNum; other details don't matter.
    M.untracked(() => {
      let context = experimentState.getSuggestionContext();
      let {prefix, curWord} = context;
      ws.send({
        type: 'requestSuggestions',
        request_id: seqNum,
        sofar: prefix,
        cur_word: curWord,
        ...state.suggestionRequestParams
      });
    });
  });
}

ws.onmessage = function(msg) {
  if (msg.type === 'suggestions') {
    dispatch({type: 'receivedSuggestions', msg});
  } else if (msg.type === 'backlog') {
    msg.body.forEach(msg => {
      state.handleEvent(msg);
    });
    init();
  }
};

dispatchDisabled = true;

// Kick it off with a request for the backlog. The handler for the response message will call 'init'.
ws.send({type: 'requestBacklog'});

function init() {
    dispatchDisabled = false;
    startRequestingSuggestions();
    setSize();
}

function setSize() {
  let width = Math.min(document.documentElement.clientWidth, screen.availWidth);
  let height = Math.min(document.documentElement.clientHeight, screen.availHeight);
  if (height < 450) {
    if (width > height)
      alert('Please rotate your phone to be in the portrait orientation.');
    else
      alert("Your screen is small; things might not work well.");
  }
  dispatch({type: 'resized', width, height});
}

window.addEventListener('resize', function() {
    setTimeout(setSize, 10);
});

class Suggestion extends Component {
  render() {
    let {onTap, word, preview, isValid} = this.props;
    return <div
      className={"Suggestion" + (isValid ? '' : ' invalid')}
      onClick={isValid ? onTap : null}
      onTouchStart={isValid ? onTap : null}>
      {word}<span className="preview">{preview.join(' ')}</span>
    </div>;
  }
}

const SuggestionsBar = inject('expState', 'dispatch')(observer(class SuggestionsBar extends Component {
  render() {
    const {expState, dispatch} = this.props;
    return <div className="SuggestionsBar">
      {expState.visibleSuggestions.map((sugg, i) => <Suggestion
        key={i}
        onTap={(evt) => {
          dispatch({type: 'tapSuggestion', slot: i});
          evt.preventDefault();
          evt.stopPropagation();
        }}
        word={sugg.words[0]}
        preview={sugg.words.slice(1)}
        isValid={sugg.isValid} />
      )}
    </div>;
  }
}));

const NextBtn = inject('dispatch', 'state', 'screens')((props) => <button onClick={() => {
  if (!props.confirm || confirm("Are you sure?")) {
    let preEvent = props.screens[props.state.screenNum + 1].preEvent;
    if (preEvent) {
      props.dispatch(preEvent);
    }
    props.dispatch({type: 'next'})
  }
  }}>{props.children || "Next"}</button>);

const ExperimentScreen = inject('state', 'dispatch')(observer(class ExperimentScreen extends Component {
  render() {
    let {state} = this.props;
    let {experimentState} = state;
    return <Provider expState={experimentState}>
      <div className="ExperimentScreen">
      <div style={{backgroundColor: '#ccc', color: 'black'}}>
        <NextBtn confirm={true}>Done</NextBtn>
      </div>
      <div className="CurText">{experimentState.curText}<span className="Cursor"></span>
      </div>
      <SuggestionsBar />
      <Keyboard dispatch={this.props.dispatch} />
    </div>
    </Provider>;
  }
}));

const ControlledInput = inject('dispatch')(({dispatch, name}) => <input
  onChange={evt => {dispatch({type: 'controlledInputChanged', name, value: evt.target.value});}} />);


const Consent = () => <div>
  <h1>Informed Consent</h1>
  <p>By continuing, you agree that you have been provided with the consent form
  for this study and agree to its terms.</p>
  <NextBtn /></div>;
const SelectRestaurants = () => <div>
  <p>Think of 2 restaurants or cafes you've been to recently.</p>
  <div>1. <ControlledInput name="restaurant1"/><br /> When were you last there? <ControlledInput name="visit1"/></div>
  <div>2. <ControlledInput name="restaurant2"/><br /> When were you last there? <ControlledInput name="visit2"/></div>
  <NextBtn />
  </div>;



const Instructions = inject('state')(observer(({state}) => <div>
    <h1>Instructions</h1>
    <p>Think about your <b>{state.places[0].visit}</b> visit to <b>{state.places[0].name}</b>.</p>
    <p>Let's write a review of this experience (like you might see on a site like Yelp or Google Maps). We'll do this in <b>two steps</b>:</p>
    <ol>
      <li>Type out a very rough draft. Here we won't be concerned about grammar, coherence, accuracy, etc.</li>
      <li>Edit what you wrote into a good review.</li>
    </ol>
    <p>Tap Next when you're ready to start typing the rough draft.</p>
    <NextBtn /></div>));
const EditScreen = inject('state', 'dispatch')(observer(({state, dispatch}) => <div className="EditPage">
    <div style={{backgroundColor: '#ccc', color: 'black'}}>
      Now, edit what you wrote to make it better. When you're done, tap <NextBtn confirm={true}>Done</NextBtn>
    </div>
    <textarea value={state.curEditText} onChange={evt => {dispatch({type: 'controlledInputChanged', name: state.curEditTextName, value: evt.target.value});}} />;
  </div>));
const PostTaskSurvey = () => <div>Post-Task <NextBtn /></div>;
const PostExpSurvey = () => <div>Post-Exp <NextBtn /></div>;
const Done = () => <div>Thanks! Your code is {clientId}.</div>;

const screens = [
  {type: 'screen', screen: <Consent />},
  {type: 'screen', screen: <SelectRestaurants />},
  {type: 'screen', preEvent: {type: 'setupExperiment', block: 0}, screen: <Instructions />},
  {type: 'screen', screen: <ExperimentScreen />},
  {type: 'screen', preEvent: {type: 'setEditFromExperiment'}, screen: <EditScreen />},
  {type: 'screen', screen: <PostTaskSurvey />},
  {type: 'screen', preEvent: {type: 'setupExperiment', block: 1}, screen: <Instructions />},
  {type: 'screen', screen: <ExperimentScreen />},
  {type: 'screen', preEvent: {type: 'setEditFromExperiment'}, screen: <EditScreen />},
  {type: 'screen', screen: <PostTaskSurvey />},
  {type: 'screen', screen: <PostExpSurvey />},
  {type: 'screen', screen: <Done />},
];

const App = observer(class App extends Component {
  render() {
    return (
      <Provider state={state} dispatch={dispatch} screens={screens}>
        <div className="App">
          {screens[state.screenNum].screen}
          <div className="clientId">{clientId}</div>
        </div>
      </Provider>
    );
  }
});

export default App;

// Globals
window.M = M;
window.state = state;
