import argparse
import pickle
import json
from sys import intern
import tqdm
import joblib
from suggestion.util import spacy_tok_to_doc, dump_kenlm
from suggestion.suffix_array import DocSuffixArray
from suggestion import tokenization
import pandas as pd
import numpy as np

import re
cant_type = re.compile(r'[^\-a-z., !\']')

spelled_out = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'.split()

def sub_numbers(txt):
    def number_form(match):
        num = int(match.group(0))
        if num < len(spelled_out):
            return spelled_out[num]
        return ''
    return re.sub(r'\b\d+\b', number_form, txt)

def convert_tokenization(doc):
    doc = doc.lower()
    doc = sub_numbers(doc)
    sents = doc.split('\n')
    sents = [cant_type.sub('', sent) for sent in sents]
    return [intern(word) for word in spacy_tok_to_doc(sents)]

def typeable_chars(text):
    text = tokenization.URL_RE.sub(' ', text)
    text = re.sub(r'\s+', ' ', text)
    return cant_type.sub('', sub_numbers(text.lower()))

def tokenize(text):
    # NOTE: Yelp preprocessing runs this same fn (almost) in preprocess_yelp_v2, copy-pasted.
    import nltk
    text = text.replace("Mr.", "Mr").replace("Mrs.", "Mrs").replace("Ms.", "Ms")
    text = tokenization.URL_RE.sub(" ", text)
    sents = nltk.sent_tokenize(text)
    token_spaced_sents = (' '.join(sent[a:b] for a, b in tokenization.token_spans(sent)) for sent in sents)
    return '\n'.join(token_spaced_sents)


def preprocess_csv(input_filename, model_name):
    import pandas as pd
    data = pd.read_csv(input_filename)
    dump_kenlm(model_name, (' '.join(convert_tokenization(tokenize(text))) for text in tqdm.tqdm(data.Text)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',
                        help='Input data filename (pickle)',
                        default='yelp_preproc/train_data.pkl')
    parser.add_argument('--model-name', default="yelp_train",
                        help="model name")
    parser.add_argument('--split-stars', action='store_true',
        help="Also train models for each review star rating.")
    parser.add_argument('--sufarr', action='store_true',
        help="Build a suffix array of all documents.")
    args = parser.parse_args()

    print("Loading...", flush=True)
    data = pd.read_pickle(args.input)
    reviews = data['data']

    tokenized_reviews = [convert_tokenization(tokenized)
        for tokenized in tqdm.tqdm(reviews.tokenized, desc="Converting format")]

    if args.split_stars:
        counts = []
        for stars in [1, 2, 3, 4, 5]:
            star_indices = np.flatnonzero(reviews.stars_review == stars)
            counts.append(len(star_indices))
            # star_indices = np.random.choice(star_indices, size=args.subsample_stars, replace=False)
            dump_kenlm(f"{args.model_name}-{stars}star", (' '.join(tokenized_reviews[idx]) for idx in tqdm.tqdm(star_indices, desc=f"Writing {stars}-star")))
        json.dump(counts, open('models/star_counts.json', 'w'))

    print("Saving reviews")
    with open('models/tokenized_reviews.pkl', 'wb') as f:
        pickle.dump(tokenized_reviews, f, -1)

    dump_kenlm(args.model_name, (' '.join(doc) for doc in tqdm.tqdm(tokenized_reviews, desc="Writing")))

    if args.sufarr:
        sufarr = DocSuffixArray.construct(tokenized_reviews)
        joblib.dump(dict(suffix_array=sufarr.suffix_array, doc_idx=sufarr.doc_idx, tok_idx=sufarr.tok_idx, lcp=sufarr.lcp), 'models/{}_sufarr.joblib'.format(args.model_name))

    # print("Training char model")
    # dump_kenlm(args.model_name+"_char", (' '.join(typeable_chars(text).replace(' ', '_')) for text in reviews.text), script='./scripts/make_char_model.sh')
