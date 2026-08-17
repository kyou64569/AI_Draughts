import subprocess
from pathlib import Path

# 脚本所在目录即项目根目录（不写死本地路径，便于整目录迁移）
ROOT = Path(__file__).resolve().parent
r = subprocess.run(
    ['cmd', '/c', 'call stop.bat < nul'],
    cwd=str(ROOT), capture_output=True, encoding='gbk', errors='ignore', timeout=40,
)
print(r.stdout)
