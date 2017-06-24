# -*- coding: utf-8 -*-
"""
Created on Wed Jun 21 15:39:40 2017

@author: kcarnold
"""

import numpy as np
import pandas as pd
from suggestion.paths import paths
import re
#%%
data_files = list((paths.parent / 'data' / 'by_participant').glob('participant_level_*.csv'))
latest = {}
for filename in data_files:
    study, date = re.match(r'participant_level_(.+)_(2017.+)', filename.name).groups()
    if study not in latest or date > latest[study][0]:
        latest[study] = date, filename
#%%
all_data = pd.concat({study: pd.read_csv(filename) for study, (date, filename) in latest.items()})
all_data.index.names = ['study', None]
all_data = all_data.reset_index('study').reset_index(drop=True)
all_data = all_data.drop_duplicates(['participant_id', 'condition', 'block', 'kind'])
#%%
all_data[all_data.study == 'study4'].kind.value_counts()

#%% MANUAL PROCESSING STEP. Dump out everything.
all_data.query('kind == "final"').loc[:,'finalText'].drop_duplicates().to_csv('all_writings.csv', index=False)

#%% Now: load that into Excel -> Copy to Word -> correct all typos and obvious misspellings
# replace newlines with spaces, remove double-spaces. Copy back into Excel.
with_corrections = pd.read_excel('all_writings_corrected.xlsx')
#%% Grumble, that has smartquotes. Fix.
with_corrections['corrected'] = with_corrections.corrected.apply(lambda s: s.replace('\u2019', "'"))

#''.join(sorted({c for txt in with_corrections.corrected for c in txt}))

#%%
with_corrections = pd.merge(all_data, with_corrections, left_on='finalText', right_on='finalText')
#%%
#import suggestion.analysis_util
#reload(suggestion.analysis_util)
#%%

from suggestion.analysis_util import get_existing_requests
participants = with_corrections.participant_id.unique().tolist()

suggestion_data_raw = {participant: get_existing_requests(paths.parent / 'logs' / f'{participant}.jsonl') for participant in participants}
#%%
suggestion_data = pd.concat({participant: pd.DataFrame(suggestions) for participant, suggestions, in suggestion_data_raw.items()}, axis=0, names=['participant_id', None])
#suggestion_data.to_csv('all_suggestion_data.csv')
#%%
latency_75 = suggestion_data.groupby(level=0).latency.apply(lambda x: np.percentile(x, 75))
#%%
with_latency = pd.merge(with_corrections, latency_75.to_frame('latency_75'), how='left', left_on='participant_id', right_index=True)
with_latency = with_latency.drop('dur_75 dur_95 mean_llk min_llk dist_from_best tokenized'.split(), axis=1)
#del with_latency['dur_75']
#del with_latency['dur_95']
with_latency['total_actions'] = with_latency.num_tapBackspace + with_latency.num_tapKey + with_latency.num_tapSugg_bos + with_latency.num_tapSugg_full + with_latency.num_tapSugg_part
with_latency['total_sugg'] = with_latency.num_tapSugg_bos + with_latency.num_tapSugg_full + with_latency.num_tapSugg_part
#%%
by_participant = pd.merge(
        with_corrections.loc[:, ['participant_id', 'num_tapBackspace' , 'num_tapKey' , 'num_tapSugg_bos' , 'num_tapSugg_full' , 'num_tapSugg_part']].groupby('participant_id').sum(),
        latency_75.to_frame('latency_75'), how='left', left_index=True, right_index=True)
by_participant['total_sugg'] = by_participant.num_tapSugg_bos + by_participant.num_tapSugg_full + by_participant.num_tapSugg_part
#%%
too_much_latency = (by_participant['latency_75'] > 500)
print(f"Excluding {np.sum(too_much_latency)} for too much latency")
#%%
too_few_actions = (by_participant['total_sugg'] < 5) | (by_participant['num_tapKey'] < 5)
print(f"Excluding {np.sum(too_few_actions)} for too few actions")
#%%
exclude = too_few_actions | too_much_latency

#%%
with_exclusions = pd.merge(with_latency, exclude.to_frame('exclude'), left_on='participant_id', right_index=True)

#%%
from suggestion.analyzers import WordFreqAnalyzer
analyzer = WordFreqAnalyzer.build()
#%%
# Hapax legomena are pruned by KenLM. Should we prune more?
[analyzer.vocab[i] for i in np.flatnonzero(analyzer.counts == 5)[:5]]
#%% Ok let's ignore any word with count < 5 in Yelp.
from suggestion import tokenization
import string
def analyze(doc):
    toks = tokenization.tokenize(doc.lower())[0]
    filtered = []
    freqs = []
    for tok in toks:
        if tok[0] not in string.ascii_letters:
            continue
        vocab_idx = analyzer.word2idx.get(tok)
        if vocab_idx is None or analyzer.counts[vocab_idx] < 5:
            print("Skipping", tok)
            continue
        filtered.append(tok)
        freqs.append(analyzer.log_freqs[vocab_idx])
    return pd.Series(dict(wf_N=len(freqs), wf_mean=np.mean(freqs), wf_std=np.std(freqs)))
word_freq_data = with_latency.corrected.apply(analyze)
with_word_freq = pd.merge(with_exclusions, word_freq_data, left_index=True, right_index=True)
#%%
with_word_freq.to_csv('all_word_freqs_2.csv', index=False)


#%%