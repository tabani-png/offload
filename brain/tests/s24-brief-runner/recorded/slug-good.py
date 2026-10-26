import re, sys
print(re.sub(r"[^a-z0-9]+", "-", sys.argv[1].lower()).strip("-"))
