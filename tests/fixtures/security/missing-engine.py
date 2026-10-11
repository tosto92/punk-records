#!/usr/bin/env python3
import runpy
import sys

sys.path = [p for p in sys.path if 'site-packages' not in p and 'dist-packages' not in p]
runpy.run_path(sys.argv[1], run_name='__main__')
