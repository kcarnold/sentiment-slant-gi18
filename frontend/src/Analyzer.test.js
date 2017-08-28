import Promise from "bluebird";
import { readLogFile } from './testUtil.js';
import { analyzeLog } from './Analyzer.js';

const participantIds = [
  //"99c66d",
  "c104c0",
  ];
let logData = null;
let analyzed = null;

function updateLog(log) {
  // Port a log to the new format.
  return log.map(entry => {
    if (false || entry.type === 'receivedSuggestions') {
      let msg = {...entry.msg};
      ['predictions', 'synonyms'].forEach(typ => {
        if (msg[typ]) {
          msg[typ] = msg[typ].map(ent => ({words: [ent.word]}));
        }
      });
      entry = {...entry, msg};
    }
    return entry;
  })
}

beforeAll(async () => {
  let logs = await Promise.map(participantIds, readLogFile);
  console.log(`Loaded ${logs.length} logs.`);
  logData = logs;
  analyzed = await Promise.map(logData, async ([participantId, log]) => [participantId, await analyzeLog(log)]);
});

it("includes the overall fields we expect", () => {
  analyzed.forEach(([participantId, analysis]) => {
    expect(analysis.conditions).toBeDefined();
    expect(analysis.byExpPage).toBeDefined();
  });
});

function expectNotToContainAttnCheck(recset) {
  recset.predictions.concat(recset.synonyms).forEach(rec => {
    expect(rec.word).not.toMatch(/æ/);
  });
}

it("extracts what suggestions were displayed", () => {
  analyzed.forEach(([participantId, result]) => {
    let page = result.byExpPage['final-0'];
    expect(page.displayedSuggs.length).toBeGreaterThan(0);
    let suggEntry = page.displayedSuggs[0];
    expect(suggEntry).toMatchObject({
      timestamp: expect.any(Number),
      context: expect.any(String),
      recs: expect.anything(),
      latency: expect.any(Number),
      action: expect.objectContaining({type: expect.any(String)}),
    });

    page.displayedSuggs.forEach(({recs, action}) => {
      if ((action || {}).type === 'tapSuggestion')
        expectNotToContainAttnCheck(recs);
    })
  });
});
