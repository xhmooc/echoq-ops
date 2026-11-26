import oss2
import pathlib
import sys

env = pathlib.Path.home() / '.aliyun' / 'echoq-ops.env'
values = {}
for line in env.read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        values[k.strip()] = v.strip()
auth = oss2.Auth(values['ALIYUN_AK_ID'], values['ALIYUN_AK_SECRET'])
bucket = oss2.Bucket(auth, 'https://oss-cn-shanghai.aliyuncs.com', 'echoq-downloads')
try:
    names = [obj.key for obj in oss2.ObjectIterator(bucket, max_keys=10)]
    print('OK', names)
except Exception as exc:
    print('ERR', type(exc).__name__, str(exc)[:300])
    sys.exit(1)
