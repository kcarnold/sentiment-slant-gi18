import string
import random
import json
import time
import os
import traceback
import datetime
import io

import tornado.ioloop
import tornado.gen
import tornado.options
import tornado.web
import tornado.websocket

from .paths import paths


from tornado.options import define, options

define("port", default=5000, help="run on the given port", type=int)

settings = dict(
    xheaders=True,
    template_path=paths.ui,
    static_path=paths.ui + '/static',
    debug=True,
    )

from . import suggestion_generator

if not os.path.isdir(paths.logdir):
    os.makedirs(paths.logdir)

import sqlite3
db_conn = sqlite3.connect(paths.db, isolation_level=None)
db_conn.execute('PRAGMA journal_mode=WAL;')
db_conn.execute('PRAGMA synchronous=NORMAL;')
db_conn.execute('CREATE TABLE IF NOT EXISTS sessions (participant_id, log_file, state)')

from concurrent.futures import ProcessPoolExecutor
process_pool = ProcessPoolExecutor()

import tornado.autoreload
tornado.autoreload.add_reload_hook(process_pool.shutdown)


active_participants = {}


class Participant:
    @classmethod
    def get_participant(cls, participant_id):
        if participant_id in active_participants:
            return active_participants[participant_id]
        participant = cls(participant_id)
        active_participants[participant_id] = participant
        return participant

    def __init__(self, participant_id):
        self.participant_id = participant_id
        self.connections = []

        self.log_file_name = os.path.join(paths.logdir, self.participant_id + '.jsonl')
        self.log_file = open(self.log_file_name, 'a+')
        self.log_file.seek(0, io.SEEK_END)

    def log(self, event):
        assert self.log_file is not None
        print(
            json.dumps(dict(event, timestamp=datetime.datetime.now().isoformat(), participant_id=self.participant_id)),
            file=self.log_file, flush=True)

    def get_log_entries(self):
        self.log_file.seek(0)
        log_entries = [json.loads(line) for line in self.log_file]
        self.log_file.seek(0, io.SEEK_END)
        return log_entries

    def broadcast(self, msg, exclude_conn):
        for conn in self.connections:
            if conn is not exclude_conn:
                conn.send_json(**msg)

    def connected(self, client):
        self.connections.append(client)
        print(client.kind, 'open', self.participant_id)

    def disconnected(self, client):
        self.connections.remove(client)
        print(client.kind, 'close', self.participant_id)


class DemoParticipant:
    participant_id = 'DEMO'

    def log(self, event):
        return

    def get_log_entries(self):
        return []

    def broadcast(self, *a, **kw):
        return


class MyWSHandler(tornado.websocket.WebSocketHandler):
    def get_compression_options(self):
        # Non-None enables compression with default options.
        return {}

    def send_json(self, **kw):
        self.write_message(json.dumps(kw))

    def on_close(self):
        if self.participant is not None:
            self.participant.disconnected(self)


class WebsocketHandler(MyWSHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.log_file = None
        self.participant = None
        self.keyRects = {}
        # There will also be a 'kind', which gets set only when the client connects.

    def open(self):
        print('ws open', flush=True)

    @tornado.gen.coroutine
    def on_message(self, message):
        try:
            start = time.time()
            request = json.loads(message)
            if request['type'] == 'requestSuggestions':
                phrases = yield process_pool.submit(suggestion_generator.get_suggestions,
                    request['sofar'], request['cur_word'],
                    domain=request.get('domain', 'yelp_train'),
                    rare_word_bonus=request.get('rare_word_bonus', 1.0),
                    use_sufarr=request.get('useSufarr', False),
                    temperature=request.get('temperature', 0.))
                result = dict(type='suggestions', timestamp=request['timestamp'], request_id=request.get('request_id'))
                result['next_word'] = suggestion_generator.phrases_to_suggs(phrases)
                self.send_json(**result)
                print('{type} in {dur:.2f}'.format(type=request['type'], dur=time.time() - start))
            elif request['type'] == 'keyRects':
                self.keyRects[request['layer']] = request['keyRects']
            elif request['type'] == 'requestBacklog':
                self.send_json(type='backlog', body=self.participant.get_log_entries())
            elif request['type'] == 'init':
                participant_id = request['participantId']
                self.kind = request['kind']
                if participant_id.startswith('demo'):
                    self.participant = DemoParticipant()
                else:
                    assert all(x in string.hexdigits for x in participant_id)
                    self.participant = Participant.get_participant(participant_id)
                    self.participant.connected(self)
                    self.participant.broadcast(dict(type='otherEvent', event=dict(type='connected', kind=self.kind)), exclude_conn=self)
            elif request['type'] == 'log':
                event = request['event']
                self.participant.log(event)
                self.participant.broadcast(dict(type='otherEvent', event=event), exclude_conn=self)
            elif request['type'] == 'ping':
                pass
            else:
                print("Unknown request type:", request['type'])
        except Exception:
            traceback.print_exc()

    def check_origin(self, origin):
        """Allow any CORS access."""
        return True



class MainHandler(tornado.web.RequestHandler):
    def head(self):
        self.finish()

    def get(self):
        self.render("index.html")


class Application(tornado.web.Application):
    def __init__(self):
        handlers = [
            (r'/', MainHandler),
            (r"/ws", WebsocketHandler),
            (r"/(style\.css)", tornado.web.StaticFileHandler, dict(path=paths.ui)),
        ]
        tornado.web.Application.__init__(self, handlers, **settings)


def main():
    tornado.options.parse_command_line()
    app = Application()
    print('serving on', options.port)
    app.listen(options.port, address='127.0.0.1')
    tornado.ioloop.IOLoop.instance().start()

if __name__ == '__main__':
    main()
