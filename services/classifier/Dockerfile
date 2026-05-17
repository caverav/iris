FROM python:3.11-slim
RUN pip install --no-cache-dir 'psycopg[binary]'
COPY classifier.py /app/classifier.py
WORKDIR /app
CMD ["python3", "-u", "/app/classifier.py"]
