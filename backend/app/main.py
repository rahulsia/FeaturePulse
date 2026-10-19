import os, uuid, shutil, secrets, subprocess, tempfile, re, json, base64, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, ForeignKey, String, Integer, Boolean, DateTime, Text, select, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker, Session
from pydantic import BaseModel, Field

DATABASE_URL=os.getenv('DATABASE_URL','sqlite:///./featurepulse.db')
engine=create_engine(DATABASE_URL, connect_args={'check_same_thread':False} if DATABASE_URL.startswith('sqlite') else {}, pool_pre_ping=True)
SessionLocal=sessionmaker(bind=engine)
STORAGE=Path(os.getenv('STORAGE_DIR','./uploads')); STORAGE.mkdir(parents=True,exist_ok=True)
MAX_UPLOAD=50*1024*1024
TOKEN=os.getenv('API_TOKEN','')
# Egress allowlist for UI tests: comma-separated hostname patterns, e.g. "internal.corp,*.internal.corp,localhost".
# Empty (default) = unrestricted, so local/dev use needs no configuration.
ALLOWED_TEST_HOSTS=[h.strip().lower() for h in os.getenv('ALLOWED_TEST_HOSTS','').split(',') if h.strip()]
def host_allowed(url:str)->bool:
    if not ALLOWED_TEST_HOSTS:return True
    try:host=(urlparse(url).hostname or '').lower()
    except Exception:return False
    if not host:return False
    for pat in ALLOWED_TEST_HOSTS:
        if pat.startswith('*.'):
            if host==pat[2:] or host.endswith(pat[1:]):return True
        elif host==pat:return True
    return False
def check_test_urls(target_url:str,steps:list):
    urls=[target_url]+[s.get('url') for s in (steps or []) if isinstance(s,dict) and s.get('action')=='goto' and s.get('url')]
    blocked=[u for u in urls if u and not host_allowed(u)]
    if blocked:
        raise HTTPException(403,f"Blocked by test egress allowlist: {', '.join(blocked)}. Allowed host patterns: {', '.join(ALLOWED_TEST_HOSTS)}")
class Base(DeclarativeBase): pass
class Application(Base):
    __tablename__='applications'
    id:Mapped[int]=mapped_column(primary_key=True)
    name:Mapped[str]=mapped_column(String(120),unique=True)
class FeatureGroup(Base):
    __tablename__='feature_groups'
    id:Mapped[int]=mapped_column(primary_key=True)
    application_id:Mapped[int]=mapped_column(ForeignKey('applications.id'))
    name:Mapped[str]=mapped_column(String(160))
    description:Mapped[str]=mapped_column(Text,default='')
    source:Mapped[str]=mapped_column(String(30),default='Manual')
class Feature(Base):
    __tablename__='features'
    id:Mapped[int]=mapped_column(primary_key=True)
    application_id:Mapped[int]=mapped_column(ForeignKey('applications.id'))
    group_id:Mapped[Optional[int]]=mapped_column(ForeignKey('feature_groups.id'),nullable=True)
    name:Mapped[str]=mapped_column(String(160))
    reviewer:Mapped[str]=mapped_column(String(160),default='')  # feedback on this feature auto-assigns here
class FeedbackQuestion(Base):
    __tablename__='feedback_questions'
    id:Mapped[int]=mapped_column(primary_key=True)
    feature_id:Mapped[int]=mapped_column(ForeignKey('features.id'))
    prompt:Mapped[str]=mapped_column(String(300))
    kind:Mapped[str]=mapped_column(String(30),default='rating')
    required:Mapped[bool]=mapped_column(Boolean,default=False)
class FeedbackAnswer(Base):
    __tablename__='feedback_answers'
    id:Mapped[int]=mapped_column(primary_key=True)
    feedback_id:Mapped[int]=mapped_column(ForeignKey('feedback.id'))
    question_id:Mapped[int]=mapped_column(ForeignKey('feedback_questions.id'))
    answer:Mapped[str]=mapped_column(Text,default='')
class Release(Base):
    __tablename__='releases'
    id:Mapped[int]=mapped_column(primary_key=True)
    application_id:Mapped[int]=mapped_column(ForeignKey('applications.id'))
    version:Mapped[str]=mapped_column(String(60))
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))

class Repository(Base):
    __tablename__='repositories'
    id:Mapped[int]=mapped_column(primary_key=True)
    application_id:Mapped[int]=mapped_column(ForeignKey('applications.id'))
    url:Mapped[str]=mapped_column(String(500))
    branch:Mapped[str]=mapped_column(String(120),default='main')
    last_commit:Mapped[str]=mapped_column(String(80),default='')
    last_scanned_at:Mapped[Optional[datetime]]=mapped_column(DateTime(timezone=True),nullable=True)
class FeatureSuggestion(Base):
    __tablename__='feature_suggestions'
    id:Mapped[int]=mapped_column(primary_key=True)
    repository_id:Mapped[int]=mapped_column(ForeignKey('repositories.id'))
    application_id:Mapped[int]=mapped_column(ForeignKey('applications.id'))
    release_id:Mapped[Optional[int]]=mapped_column(ForeignKey('releases.id'),nullable=True)
    name:Mapped[str]=mapped_column(String(160))
    category:Mapped[str]=mapped_column(String(120),default='General')
    evidence:Mapped[str]=mapped_column(Text,default='')
    confidence:Mapped[int]=mapped_column(Integer,default=60)
    status:Mapped[str]=mapped_column(String(20),default='Pending')
    detected_commit:Mapped[str]=mapped_column(String(80),default='')
class FeatureRelease(Base):
    __tablename__='feature_releases'
    id:Mapped[int]=mapped_column(primary_key=True)
    feature_id:Mapped[int]=mapped_column(ForeignKey('features.id'))
    release_id:Mapped[int]=mapped_column(ForeignKey('releases.id'))
    state:Mapped[str]=mapped_column(String(20),default='Present')
    source:Mapped[str]=mapped_column(String(30),default='Git discovery')

class Feedback(Base):
    __tablename__='feedback'
    id:Mapped[int]=mapped_column(primary_key=True)
    feature_id:Mapped[int]=mapped_column(ForeignKey('features.id'))
    reported_release_id:Mapped[int]=mapped_column(ForeignKey('releases.id'))
    title:Mapped[str]=mapped_column(String(220))
    description:Mapped[str]=mapped_column(Text,default='')
    source_url:Mapped[str]=mapped_column(String(2000),default='')
    reporter:Mapped[str]=mapped_column(String(120),default='')
    assignee:Mapped[str]=mapped_column(String(120),default='')
    severity:Mapped[str]=mapped_column(String(20),default='Medium')
    status:Mapped[str]=mapped_column(String(30),default='Open')
    regression_required:Mapped[bool]=mapped_column(Boolean,default=False)
    jira_ticket:Mapped[str]=mapped_column(String(300),default='')  # ticket key (PROJ-123) or full URL
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
class Evidence(Base):
    __tablename__='evidence'
    id:Mapped[int]=mapped_column(primary_key=True)
    feedback_id:Mapped[int]=mapped_column(ForeignKey('feedback.id'))
    stored_name:Mapped[str]=mapped_column(String(150))
    original_name:Mapped[str]=mapped_column(String(255))
    mime_type:Mapped[str]=mapped_column(String(100))
class Validation(Base):
    __tablename__='validations'
    id:Mapped[int]=mapped_column(primary_key=True)
    feedback_id:Mapped[int]=mapped_column(ForeignKey('feedback.id'))
    release_id:Mapped[int]=mapped_column(ForeignKey('releases.id'))
    result:Mapped[str]=mapped_column(String(20))
    tester:Mapped[str]=mapped_column(String(120))
    notes:Mapped[str]=mapped_column(Text,default='')
    tested_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
class Test(Base):
    __tablename__='tests'
    id:Mapped[int]=mapped_column(primary_key=True)
    feature_id:Mapped[int]=mapped_column(ForeignKey('features.id'))
    name:Mapped[str]=mapped_column(String(200))
    target_url:Mapped[str]=mapped_column(String(2000))
    steps:Mapped[str]=mapped_column(Text,default='[]')  # JSON array of step objects
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
class TestRun(Base):
    __tablename__='test_runs'
    id:Mapped[int]=mapped_column(primary_key=True)
    test_id:Mapped[int]=mapped_column(ForeignKey('tests.id'))
    release_id:Mapped[Optional[int]]=mapped_column(ForeignKey('releases.id'),nullable=True)
    status:Mapped[str]=mapped_column(String(20),default='Pending')  # Pass|Fail|Error
    duration_ms:Mapped[int]=mapped_column(Integer,default=0)
    steps_log:Mapped[str]=mapped_column(Text,default='[]')
    screenshots:Mapped[str]=mapped_column(Text,default='[]')
    console_errors:Mapped[str]=mapped_column(Text,default='[]')
    error:Mapped[str]=mapped_column(Text,default='')
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
Base.metadata.create_all(engine)
# Lightweight migrations for local SQLite databases created before a given column existed.
if engine.dialect.name=='sqlite':
    with engine.begin() as connection:
        fb_cols={row[1] for row in connection.exec_driver_sql('PRAGMA table_info(feedback)')}
        if 'source_url' not in fb_cols:
            connection.exec_driver_sql("ALTER TABLE feedback ADD COLUMN source_url VARCHAR(2000) NOT NULL DEFAULT ''")
        if 'jira_ticket' not in fb_cols:
            connection.exec_driver_sql("ALTER TABLE feedback ADD COLUMN jira_ticket VARCHAR(300) NOT NULL DEFAULT ''")
        feat_cols={row[1] for row in connection.exec_driver_sql('PRAGMA table_info(features)')}
        if 'reviewer' not in feat_cols:
            connection.exec_driver_sql("ALTER TABLE features ADD COLUMN reviewer VARCHAR(160) NOT NULL DEFAULT ''")
JIRA_BASE_URL=os.getenv('JIRA_BASE_URL','').rstrip('/')
JIRA_PROJECT_KEY=os.getenv('JIRA_PROJECT_KEY','')
JIRA_EMAIL=os.getenv('JIRA_EMAIL','')
JIRA_API_TOKEN=os.getenv('JIRA_API_TOKEN','')
JIRA_ISSUE_TYPE=os.getenv('JIRA_ISSUE_TYPE','Bug')
JIRA_API_VERSION=os.getenv('JIRA_API_VERSION','3')  # '3' = Jira Cloud (rich-text description), '2' = Jira Server/Data Center (plain text)
def jira_can_create():
    return bool(JIRA_BASE_URL and JIRA_EMAIL and JIRA_API_TOKEN and JIRA_PROJECT_KEY)
def jira_create_issue(summary:str,description_text:str):
    """Create a real issue in JIRA via its REST API. Raises HTTPException with
    JIRA's own error detail on failure — never silently pretends to succeed."""
    if not jira_can_create():
        missing=[n for n,v in (('JIRA_BASE_URL',JIRA_BASE_URL),('JIRA_EMAIL',JIRA_EMAIL),('JIRA_API_TOKEN',JIRA_API_TOKEN),('JIRA_PROJECT_KEY',JIRA_PROJECT_KEY)) if not v]
        raise HTTPException(400,f"JIRA ticket creation is not configured on the server. Missing: {', '.join(missing)}")
    if JIRA_API_VERSION=='2':
        description=description_text
    else:
        paragraphs=[{'type':'paragraph','content':[{'type':'text','text':line}]} for line in description_text.split('\n') if line.strip()] or [{'type':'paragraph','content':[{'type':'text','text':' '}]}]
        description={'type':'doc','version':1,'content':paragraphs}
    payload={'fields':{'project':{'key':JIRA_PROJECT_KEY},'summary':summary[:255],'issuetype':{'name':JIRA_ISSUE_TYPE},'description':description}}
    url=f"{JIRA_BASE_URL}/rest/api/{JIRA_API_VERSION}/issue"
    auth=base64.b64encode(f'{JIRA_EMAIL}:{JIRA_API_TOKEN}'.encode()).decode()
    req=urllib.request.Request(url,data=json.dumps(payload).encode(),method='POST',headers={
        'Authorization':f'Basic {auth}','Content-Type':'application/json','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as resp:
            data=json.loads(resp.read().decode())
            key=data.get('key')
            if not key:raise HTTPException(502,'JIRA accepted the request but returned no ticket key')
            return {'key':key,'url':f'{JIRA_BASE_URL}/browse/{key}'}
    except urllib.error.HTTPError as e:
        body=e.read().decode(errors='ignore')
        try:
            parsed=json.loads(body)
            msgs=parsed.get('errorMessages') or []
            field_errs=parsed.get('errors') or {}
            detail='; '.join(list(msgs)+[f'{k}: {v}' for k,v in field_errs.items()]) or body[:300]
        except Exception:
            detail=body[:300] or e.reason
        raise HTTPException(502,f'JIRA rejected the request (HTTP {e.code}): {detail}')
    except urllib.error.URLError as e:
        raise HTTPException(502,f'Could not reach JIRA at {JIRA_BASE_URL}: {e.reason}')
    except TimeoutError:
        raise HTTPException(502,f'JIRA at {JIRA_BASE_URL} did not respond in time')
FEEDBACK_STATUSES=('Open','In Progress','Fixed','By Design','Will Fix Later','Resolved','Validation','Closed','Regression')
app=FastAPI(title='FeaturePulse API',version='1.0.0')
app.add_middleware(CORSMiddleware,allow_origins=os.getenv('CORS_ORIGINS','http://localhost:5173').split(','),allow_methods=['*'],allow_headers=['*'])
def db():
    with SessionLocal() as s: yield s
def auth(authorization:Optional[str]=Header(None)):
    if TOKEN and not secrets.compare_digest(authorization or '',f'Bearer {TOKEN}'):
        raise HTTPException(401,'Invalid API token')
class AppIn(BaseModel): name:str=Field(min_length=1,max_length=120)
class FeatureGroupIn(BaseModel): application_id:int; name:str=Field(min_length=1,max_length=160); description:str=''; source:str='Manual'
class FeatureIn(BaseModel): application_id:int; name:str=Field(min_length=1,max_length=160); group_id:Optional[int]=None; reviewer:str=''
class FeatureUpdateIn(BaseModel): name:Optional[str]=None; group_id:Optional[int]=None; reviewer:Optional[str]=None
class FeedbackQuestionIn(BaseModel): feature_id:int; prompt:str=Field(min_length=1,max_length=300); kind:str='rating'; required:bool=False
class ReleaseIn(BaseModel): application_id:int; version:str=Field(min_length=1,max_length=60)
class FeedbackIn(BaseModel):
    feature_id:int; reported_release_id:int; title:str=Field(min_length=1,max_length=220)
    description:str=''; source_url:str=Field(default='',max_length=2000); reporter:str=''; assignee:str=''; severity:str='Medium'; regression_required:bool=False
class UpdateIn(BaseModel): status:Optional[str]=None; assignee:Optional[str]=None; regression_required:Optional[bool]=None; jira_ticket:Optional[str]=None
class ValidationIn(BaseModel): feedback_id:int; release_id:int; result:str; tester:str; notes:str=''
class RepositoryIn(BaseModel): application_id:int; url:str=Field(min_length=4,max_length=500); branch:str='main'
class ScanIn(BaseModel): release_id:Optional[int]=None
class SuggestionActionIn(BaseModel): action:str; merge_feature_id:Optional[int]=None
class AssistantIn(BaseModel): application_id:int; message:str=Field(min_length=1,max_length=1000)
class TestIn(BaseModel): feature_id:int; name:str=Field(min_length=1,max_length=200); target_url:str=Field(min_length=4,max_length=2000); steps:list=Field(default_factory=list)
class TestUpdateIn(BaseModel): name:Optional[str]=None; target_url:Optional[str]=None; steps:Optional[list]=None
class RunIn(BaseModel): release_id:Optional[int]=None
class ImportIn(BaseModel): application_id:int; feature_id:Optional[int]=None; target_url:str=''; format:str='auto'; content:str=Field(min_length=1,max_length=200000)
def asdict(x): return {c.name:getattr(x,c.name) for c in x.__table__.columns}
def get_or_404(s,model,id):
    x=s.get(model,id)
    if not x: raise HTTPException(404,f'{model.__name__} not found')
    return x
@app.get('/health')
def health():return {'status':'ok'}
@app.get('/applications',dependencies=[Depends(auth)])
def apps(s:Session=Depends(db)):return [asdict(x) for x in s.scalars(select(Application).order_by(Application.name))]
@app.post('/applications',dependencies=[Depends(auth)])
def add_app(v:AppIn,s:Session=Depends(db)):
    if s.scalar(select(Application).where(Application.name==v.name)):raise HTTPException(409,'Application exists')
    x=Application(**v.model_dump());s.add(x);s.commit();s.refresh(x);return asdict(x)

@app.get('/feature-groups',dependencies=[Depends(auth)])
def groups(db:Session=Depends(db)):
    return list(db.scalars(select(FeatureGroup).order_by(FeatureGroup.name)))
@app.post('/feature-groups',dependencies=[Depends(auth)])
def add_group(x:FeatureGroupIn,db:Session=Depends(db)):
    if not db.get(Application,x.application_id): raise HTTPException(404,'Application not found')
    o=FeatureGroup(**x.model_dump());db.add(o);db.commit();db.refresh(o);return o
@app.get('/feedback-questions',dependencies=[Depends(auth)])
def questions(feature_id:Optional[int]=None,db:Session=Depends(db)):
    q=select(FeedbackQuestion).order_by(FeedbackQuestion.id)
    if feature_id:q=q.where(FeedbackQuestion.feature_id==feature_id)
    return list(db.scalars(q))
@app.post('/feedback-questions',dependencies=[Depends(auth)])
def add_question(x:FeedbackQuestionIn,db:Session=Depends(db)):
    if not db.get(Feature,x.feature_id): raise HTTPException(404,'Feature not found')
    o=FeedbackQuestion(**x.model_dump());db.add(o);db.commit();db.refresh(o);return o

@app.get('/features',dependencies=[Depends(auth)])
def features(application_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(Feature)
    if application_id:q=q.where(Feature.application_id==application_id)
    return [asdict(x) for x in s.scalars(q.order_by(Feature.name))]
@app.post('/features',dependencies=[Depends(auth)])
def add_feature(v:FeatureIn,s:Session=Depends(db)):
    get_or_404(s,Application,v.application_id)
    x=Feature(**v.model_dump());s.add(x);s.commit();s.refresh(x);return asdict(x)
@app.patch('/features/{feature_id}',dependencies=[Depends(auth)])
def update_feature(feature_id:int,v:FeatureUpdateIn,s:Session=Depends(db)):
    x=get_or_404(s,Feature,feature_id)
    if v.name is not None:x.name=v.name
    if v.group_id is not None:x.group_id=v.group_id or None
    if v.reviewer is not None:x.reviewer=v.reviewer
    s.commit();s.refresh(x);return asdict(x)
@app.get('/releases',dependencies=[Depends(auth)])
def releases(application_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(Release)
    if application_id:q=q.where(Release.application_id==application_id)
    return [asdict(x) for x in s.scalars(q.order_by(Release.id.desc()))]
@app.post('/releases',dependencies=[Depends(auth)])
def add_release(v:ReleaseIn,s:Session=Depends(db)):
    get_or_404(s,Application,v.application_id)
    if s.scalar(select(Release).where(Release.application_id==v.application_id,Release.version==v.version)):raise HTTPException(409,'Release exists')
    x=Release(**v.model_dump());s.add(x);s.commit();s.refresh(x);return asdict(x)
def feedback_out(s,x):
    d=asdict(x)
    d['evidence']=[{'id':e.id,'name':e.original_name,'mime_type':e.mime_type} for e in s.scalars(select(Evidence).where(Evidence.feedback_id==x.id))]
    return d
@app.get('/feedback',dependencies=[Depends(auth)])
def feedback(application_id:Optional[int]=None,release_id:Optional[int]=None,feature_id:Optional[int]=None,status:Optional[str]=None,regression_only:bool=False,s:Session=Depends(db)):
    q=select(Feedback).join(Feature)
    if application_id:q=q.where(Feature.application_id==application_id)
    if release_id:q=q.where(Feedback.reported_release_id==release_id)
    if feature_id:q=q.where(Feedback.feature_id==feature_id)
    if status:q=q.where(Feedback.status==status)
    if regression_only:q=q.where(Feedback.regression_required==True)
    return [feedback_out(s,x) for x in s.scalars(q.order_by(Feedback.id.desc()))]
@app.post('/feedback',dependencies=[Depends(auth)])
def add_feedback(v:FeedbackIn,s:Session=Depends(db)):
    feature=get_or_404(s,Feature,v.feature_id);release=get_or_404(s,Release,v.reported_release_id)
    if feature.application_id!=release.application_id:raise HTTPException(400,'Feature and release must belong to same application')
    if v.severity not in ('Low','Medium','High','Critical'):raise HTTPException(400,'Invalid severity')
    data=v.model_dump()
    if not data.get('assignee','').strip() and feature.reviewer:
        data['assignee']=feature.reviewer  # auto-assign to the feature's reviewer when no one was named
    x=Feedback(**data);s.add(x);s.commit();s.refresh(x);return feedback_out(s,x)
@app.patch('/feedback/{feedback_id}',dependencies=[Depends(auth)])
def update_feedback(feedback_id:int,v:UpdateIn,s:Session=Depends(db)):
    x=get_or_404(s,Feedback,feedback_id)
    if v.status is not None:
        if v.status not in FEEDBACK_STATUSES:raise HTTPException(400,'Invalid status')
        x.status=v.status
    if v.jira_ticket is not None:x.jira_ticket=v.jira_ticket.strip()[:300]
    if v.assignee is not None:x.assignee=v.assignee
    if v.regression_required is not None:x.regression_required=v.regression_required
    s.commit();return feedback_out(s,x)
@app.post('/feedback/{feedback_id}/evidence',dependencies=[Depends(auth)])
async def upload(feedback_id:int,file:UploadFile=File(...),s:Session=Depends(db)):
    get_or_404(s,Feedback,feedback_id)
    allowed={'image/png','.jpg','image/jpeg','image/webp','video/webm','video/mp4'}
    if file.content_type not in allowed:raise HTTPException(415,'Only PNG/JPEG/WebP/WebM/MP4 accepted')
    suffix={ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/webm':'.webm','video/mp4':'.mp4'}[file.content_type]
    name=f'{uuid.uuid4().hex}{suffix}';dest=STORAGE/name;total=0
    try:
        with dest.open('wb') as out:
            while chunk:=await file.read(1024*1024):
                total+=len(chunk)
                if total>MAX_UPLOAD:raise HTTPException(413,'File exceeds 50 MB')
                out.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True);raise
    e=Evidence(feedback_id=feedback_id,stored_name=name,original_name=(file.filename or 'attachment')[:255],mime_type=file.content_type)
    s.add(e);s.commit();s.refresh(e);return {'id':e.id,'name':e.original_name}
@app.get('/evidence/{evidence_id}',dependencies=[Depends(auth)])
def download(evidence_id:int,s:Session=Depends(db)):
    e=get_or_404(s,Evidence,evidence_id);return FileResponse(STORAGE/e.stored_name,media_type=e.mime_type,filename=e.original_name)
@app.get('/regression',dependencies=[Depends(auth)])
def regression(release_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(Feedback).where(Feedback.regression_required==True)
    if release_id:
        rel=get_or_404(s,Release,release_id)
        q=q.join(Feature).where(Feature.application_id==rel.application_id,Feedback.reported_release_id<=rel.id)
    result=[]
    for f in s.scalars(q.order_by(Feedback.id.desc())):
        d=feedback_out(s,f)
        last=s.scalar(select(Validation).where(Validation.feedback_id==f.id,*([Validation.release_id==release_id] if release_id else [])).order_by(Validation.id.desc()))
        d['validation']=asdict(last) if last else None
        result.append(d)
    return result
@app.post('/validations',dependencies=[Depends(auth)])
def validate(v:ValidationIn,s:Session=Depends(db)):
    f=get_or_404(s,Feedback,v.feedback_id);r=get_or_404(s,Release,v.release_id)
    feature=get_or_404(s,Feature,f.feature_id)
    if feature.application_id!=r.application_id:raise HTTPException(400,'Different application')
    if v.result not in ('Pass','Fail','Blocked'):raise HTTPException(400,'Invalid result')
    x=Validation(**v.model_dump());s.add(x)
    if v.result=='Fail':f.status='Regression'
    s.commit();s.refresh(x);return asdict(x)
@app.get('/compare',dependencies=[Depends(auth)])
def compare(release_a:int,release_b:int,s:Session=Depends(db)):
    a=get_or_404(s,Release,release_a);b=get_or_404(s,Release,release_b)
    if a.application_id!=b.application_id:raise HTTPException(400,'Compare releases from the same application')
    def stats(r):
        rows=list(s.scalars(select(Feedback).where(Feedback.reported_release_id==r.id)))
        validations=list(s.scalars(select(Validation).where(Validation.release_id==r.id)))
        frs=list(s.scalars(select(FeatureRelease).where(FeatureRelease.release_id==r.id))); return {'release':r.version,'feature_count':len(frs),'feedback_count':len(rows),'open_count':sum(x.status in ('Open','In Progress','Regression','Will Fix Later') for x in rows),'critical_count':sum(x.severity=='Critical' for x in rows),'regression_failures':sum(x.result=='Fail' for x in validations),'regression_passes':sum(x.result=='Pass' for x in validations)}
    return {'a':stats(a),'b':stats(b)}


# --- Repository intelligence / feature discovery ---
IGNORE_DIRS={'.git','node_modules','dist','build','vendor','.next','.venv','venv','coverage','__pycache__'}
TEXT_EXT={'.md','.txt','.tsx','.ts','.jsx','.js','.py','.java','.cs','.go','.rb','.php','.vue','.html','.yaml','.yml','.json'}
STOP={'index','main','app','component','components','page','pages','route','routes','api','test','tests','spec','utils','utility','helper','helpers','common','shared','base','layout','types','config','service','services','model','models'}
def humanize(v:str):
    v=re.sub(r'([a-z0-9])([A-Z])',r'\1 \2',v);v=re.sub(r'[-_]+',' ',v);v=re.sub(r'\s+',' ',v).strip()
    return v[:1].upper()+v[1:] if v else v
def discover_features(root:Path):
    found={}
    def add(name,cat,evidence,score):
        name=humanize(name)
        if len(name)<3 or name.lower() in STOP or name.lower().endswith(('test','spec')):return
        key=name.lower()
        if key not in found or score>found[key]['confidence']:found[key]={'name':name[:160],'category':humanize(cat or 'General')[:120],'evidence':evidence[:800],'confidence':min(score,95)}
    for path in root.rglob('*'):
        if not path.is_file() or any(x in IGNORE_DIRS for x in path.parts) or path.suffix.lower() not in TEXT_EXT:continue
        try:
            rel=path.relative_to(root);size=path.stat().st_size
            if size>600_000:continue
            text=path.read_text(errors='ignore')
        except Exception:continue
        parts=list(rel.parts); low=[x.lower() for x in parts]
        # UI pages/screens are strong feature signals
        if any(x in ('pages','screens','views') for x in low):
            stem=path.stem
            if stem.lower() not in STOP:add(stem, parts[-2] if len(parts)>1 else 'UI',f'UI page: {rel}',88)
        # route declarations / paths
        for m in re.finditer(r"(?:path\s*[:=]|route\s*[:=]|@(?:app|router)\.(?:get|post|put|patch|delete)\()\s*[\"'](/[^\"']+)[\"']",text,re.I):
            route=m.group(1).split('?')[0]; seg=[x for x in route.split('/') if x and not x.startswith((':','{'))]
            if seg:add(seg[-1],seg[-2] if len(seg)>1 else 'Routes',f'Route {route} in {rel}',78)
        # README/document headings describe user capabilities
        if path.suffix.lower()=='.md':
            for m in re.finditer(r'^#{1,3}\s+(.+)$',text,re.M):
                h=re.sub(r'[`*_#]','',m.group(1)).strip()
                if 3<=len(h)<=80 and not any(w in h.lower() for w in ('install','setup','contribut','license','prerequisite','architecture','development','deploy')):add(h,'Documentation',f'Heading in {rel}',72)
        # React components with feature-like names
        if path.suffix.lower() in ('.tsx','.jsx','.vue'):
            stem=re.sub(r'(Page|View|Screen|Component)$','',path.stem,flags=re.I)
            if stem.lower() not in STOP:add(stem,parts[-2] if len(parts)>1 else 'UI',f'UI component: {rel}',62)
    return sorted(found.values(),key=lambda x:(-x['confidence'],x['name']))[:100]

def clone_repo(repo:Repository):
    tmp=Path(tempfile.mkdtemp(prefix='featurepulse-repo-'))
    try:
        cmd=['git','clone','--depth','1','--branch',repo.branch,repo.url,str(tmp/'repo')]
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=90)
        if r.returncode!=0:raise HTTPException(400,'Git clone failed. Check repository URL, branch, and server-side Git credentials. '+r.stderr[-300:])
        commit=subprocess.run(['git','-C',str(tmp/'repo'),'rev-parse','HEAD'],capture_output=True,text=True,timeout=10).stdout.strip()
        return tmp,tmp/'repo',commit
    except subprocess.TimeoutExpired:
        shutil.rmtree(tmp,ignore_errors=True);raise HTTPException(408,'Repository clone timed out')

@app.get('/repositories',dependencies=[Depends(auth)])
def repositories(application_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(Repository)
    if application_id:q=q.where(Repository.application_id==application_id)
    return [asdict(x) for x in s.scalars(q.order_by(Repository.id.desc()))]
@app.post('/repositories',dependencies=[Depends(auth)])
def add_repository(v:RepositoryIn,s:Session=Depends(db)):
    get_or_404(s,Application,v.application_id)
    if not (v.url.startswith('https://') or v.url.startswith('http://') or v.url.startswith('git@')):raise HTTPException(400,'Use an HTTP(S) or SSH Git repository URL')
    x=Repository(**v.model_dump());s.add(x);s.commit();s.refresh(x);return asdict(x)

@app.post('/demo/git-discovery',dependencies=[Depends(auth)])
def seed_git_discovery_demo(s:Session=Depends(db)):
    """Create a repeatable local demo of the repository discovery review flow."""
    app_record=s.scalar(select(Application).where(Application.name=='Demo Commerce Portal'))
    if not app_record:
        app_record=Application(name='Demo Commerce Portal');s.add(app_record);s.flush()
    release=s.scalar(select(Release).where(Release.application_id==app_record.id,Release.version=='2.4.0'))
    if not release:
        release=Release(application_id=app_record.id,version='2.4.0');s.add(release);s.flush()
    catalog=s.scalar(select(Feature).where(Feature.application_id==app_record.id,Feature.name=='Product catalog'))
    if not catalog:
        catalog=Feature(application_id=app_record.id,name='Product catalog');s.add(catalog);s.flush()
    repo=s.scalar(select(Repository).where(Repository.application_id==app_record.id,Repository.url=='https://github.com/example/demo-commerce-portal.git'))
    if not repo:
        repo=Repository(application_id=app_record.id,url='https://github.com/example/demo-commerce-portal.git',branch='main',last_commit='demo8c1f5',last_scanned_at=datetime.now(timezone.utc));s.add(repo);s.flush()
    for name,category,evidence,confidence in [
        ('Checkout','Commerce','Route /checkout in src/routes/checkout.tsx',91),
        ('Order tracking','Orders','UI page: src/pages/OrderTracking.tsx',88),
        ('Saved items','Commerce','Documentation heading in README.md',74),
    ]:
        exists=s.scalar(select(FeatureSuggestion).where(FeatureSuggestion.repository_id==repo.id,FeatureSuggestion.name==name))
        if not exists:s.add(FeatureSuggestion(repository_id=repo.id,application_id=app_record.id,release_id=release.id,name=name,category=category,evidence=evidence,confidence=confidence,status='Pending',detected_commit='demo8c1f5'))
    s.commit()
    return {'application_id':app_record.id,'release_id':release.id,'message':'Demo data loaded. No GitHub repository was contacted.'}

@app.post('/repositories/{repository_id}/scan',dependencies=[Depends(auth)])
def scan_repository(repository_id:int,v:ScanIn,s:Session=Depends(db)):
    repo=get_or_404(s,Repository,repository_id)
    if v.release_id:
        rel=get_or_404(s,Release,v.release_id)
        if rel.application_id!=repo.application_id:raise HTTPException(400,'Release belongs to a different application')
    tmp,root,commit=clone_repo(repo)
    try: items=discover_features(root)
    finally: shutil.rmtree(tmp,ignore_errors=True)
    existing={x.name.lower() for x in s.scalars(select(Feature).where(Feature.application_id==repo.application_id))}
    # Replace only pending suggestions for this repository, preserving review history.
    for old in s.scalars(select(FeatureSuggestion).where(FeatureSuggestion.repository_id==repo.id,FeatureSuggestion.status=='Pending')):s.delete(old)
    created=[]
    for item in items:
        if item['name'].lower() in existing:continue
        x=FeatureSuggestion(repository_id=repo.id,application_id=repo.application_id,release_id=v.release_id,detected_commit=commit,**item);s.add(x);created.append(x)
    repo.last_commit=commit;repo.last_scanned_at=datetime.now(timezone.utc);s.commit()
    for x in created:s.refresh(x)
    return {'repository':asdict(repo),'suggestions':[asdict(x) for x in created],'detected':len(items),'new_suggestions':len(created)}
@app.get('/feature-suggestions',dependencies=[Depends(auth)])
def feature_suggestions(application_id:Optional[int]=None,status:Optional[str]='Pending',s:Session=Depends(db)):
    q=select(FeatureSuggestion)
    if application_id:q=q.where(FeatureSuggestion.application_id==application_id)
    if status:q=q.where(FeatureSuggestion.status==status)
    return [asdict(x) for x in s.scalars(q.order_by(FeatureSuggestion.confidence.desc(),FeatureSuggestion.id.desc()))]
@app.post('/feature-suggestions/{suggestion_id}/action',dependencies=[Depends(auth)])
def suggestion_action(suggestion_id:int,v:SuggestionActionIn,s:Session=Depends(db)):
    x=get_or_404(s,FeatureSuggestion,suggestion_id); action=v.action.lower()
    if action=='accept':
        feature=s.scalar(select(Feature).where(Feature.application_id==x.application_id,func.lower(Feature.name)==x.name.lower()))
        if not feature:feature=Feature(application_id=x.application_id,name=x.name);s.add(feature);s.flush()
        if x.release_id and not s.scalar(select(FeatureRelease).where(FeatureRelease.feature_id==feature.id,FeatureRelease.release_id==x.release_id)):
            s.add(FeatureRelease(feature_id=feature.id,release_id=x.release_id,state='Present'))
        x.status='Accepted'
    elif action=='merge':
        feature=get_or_404(s,Feature,v.merge_feature_id or 0)
        if feature.application_id!=x.application_id:raise HTTPException(400,'Feature belongs to a different application')
        if x.release_id and not s.scalar(select(FeatureRelease).where(FeatureRelease.feature_id==feature.id,FeatureRelease.release_id==x.release_id)):
            s.add(FeatureRelease(feature_id=feature.id,release_id=x.release_id,state='Present'))
        x.status='Merged'
    elif action=='ignore':x.status='Ignored'
    else:raise HTTPException(400,'Action must be accept, merge, or ignore')
    s.commit();return asdict(x)
@app.get('/release-features',dependencies=[Depends(auth)])
def release_features(release_id:int,s:Session=Depends(db)):
    rel=get_or_404(s,Release,release_id)
    rows=[]
    for fr in s.scalars(select(FeatureRelease).where(FeatureRelease.release_id==release_id)):
        f=get_or_404(s,Feature,fr.feature_id);rows.append({'feature_id':f.id,'name':f.name,'state':fr.state,'source':fr.source})
    return {'release':rel.version,'features':rows}
@app.post('/feature-assistant',dependencies=[Depends(auth)])
def feature_assistant(v:AssistantIn,s:Session=Depends(db)):
    get_or_404(s,Application,v.application_id); msg=v.message.lower()
    fs=list(s.scalars(select(Feature).where(Feature.application_id==v.application_id).order_by(Feature.name)))
    pending=list(s.scalars(select(FeatureSuggestion).where(FeatureSuggestion.application_id==v.application_id,FeatureSuggestion.status=='Pending').order_by(FeatureSuggestion.confidence.desc())))
    if any(w in msg for w in ('pending','suggest','discover','git','repository')):
        return {'answer':f'I found {len(pending)} pending Git-discovered feature suggestions. Review them below before adding them to the catalog.','features':[{'id':x.id,'name':x.name,'category':x.category,'confidence':x.confidence,'type':'suggestion'} for x in pending[:20]]}
    terms=[w for w in re.findall(r'[a-z0-9]+',msg) if len(w)>2 and w not in {'show','list','feature','features','related','what','does','have','all','the','for','this'}]
    matches=[x for x in fs if not terms or any(t in x.name.lower() for t in terms)]
    if matches:return {'answer':f'I found {len(matches)} matching catalog feature(s).','features':[{'id':x.id,'name':x.name,'type':'catalog'} for x in matches[:30]]}
    return {'answer':'No matching approved feature was found. Connect and scan a repository, or add the feature manually.','features':[]}

# --- Authored E2E UI testing ---
RUNNER=Path(__file__).resolve().parent.parent/'runner'/'run_test.mjs'
TESTRUN_DIR=STORAGE/'testruns'; TESTRUN_DIR.mkdir(parents=True,exist_ok=True)
VALID_ACTIONS={'goto','wait','waitFor','click','fill','expectVisible','expectText','screenshot'}
def node_bin():
    return shutil.which('node') or next((p for p in ('/usr/local/bin/node','/opt/homebrew/bin/node','/usr/bin/node') if Path(p).exists()),None)
def clean_steps(raw):
    out=[]
    for st in (raw or []):
        if not isinstance(st,dict) or st.get('action') not in VALID_ACTIONS:raise HTTPException(400,f'Invalid step: {st}')
        out.append({k:v for k,v in st.items() if k in ('action','selector','text','value','url','name','timeout')})
    return out
def test_out(s,x):
    d=asdict(x); d['steps']=json.loads(x.steps or '[]')
    last=s.scalar(select(TestRun).where(TestRun.test_id==x.id).order_by(TestRun.id.desc()))
    d['last_run']={'id':last.id,'status':last.status,'created_at':last.created_at} if last else None
    feat=s.get(Feature,x.feature_id); d['feature_name']=feat.name if feat else ''
    d['application_id']=feat.application_id if feat else None
    return d
def run_out(x):
    d=asdict(x)
    for k in ('steps_log','screenshots','console_errors'):d[k]=json.loads(getattr(x,k) or '[]')
    return d
@app.get('/tests/egress-policy',dependencies=[Depends(auth)])
def egress_policy():
    return {'enforced':bool(ALLOWED_TEST_HOSTS),'patterns':ALLOWED_TEST_HOSTS}
@app.get('/integrations/jira',dependencies=[Depends(auth)])
def jira_integration():
    return {'configured':bool(JIRA_BASE_URL),'can_create':jira_can_create(),'base_url':JIRA_BASE_URL,'project_key':JIRA_PROJECT_KEY,'issue_type':JIRA_ISSUE_TYPE}
@app.post('/feedback/{feedback_id}/jira-ticket',dependencies=[Depends(auth)])
def create_jira_ticket(feedback_id:int,s:Session=Depends(db)):
    x=get_or_404(s,Feedback,feedback_id)
    feature=s.get(Feature,x.feature_id);release=s.get(Release,x.reported_release_id)
    lines=[
        f'Feature: {feature.name if feature else "-"}',
        f'Release: {release.version if release else "-"}',
        f'Severity: {x.severity}',
        f'Reporter: {x.reporter or "-"}',
        f'Observed on: {x.source_url}' if x.source_url else '',
        '',
        'Description:',
        x.description or '(none provided)',
        '',
        f'Filed from FeaturePulse — feedback #{x.id}',
    ]
    result=jira_create_issue(x.title,'\n'.join(l for l in lines if l is not None))
    x.jira_ticket=result['key'];s.commit();s.refresh(x)
    return {'key':result['key'],'url':result['url'],'feedback':feedback_out(s,x)}
@app.get('/tests',dependencies=[Depends(auth)])
def list_tests(application_id:Optional[int]=None,feature_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(Test).join(Feature)
    if application_id:q=q.where(Feature.application_id==application_id)
    if feature_id:q=q.where(Test.feature_id==feature_id)
    return [test_out(s,x) for x in s.scalars(q.order_by(Test.id.desc()))]
@app.post('/tests',dependencies=[Depends(auth)])
def add_test(v:TestIn,s:Session=Depends(db)):
    get_or_404(s,Feature,v.feature_id)
    steps=clean_steps(v.steps);check_test_urls(v.target_url,steps)
    x=Test(feature_id=v.feature_id,name=v.name,target_url=v.target_url,steps=json.dumps(steps))
    s.add(x);s.commit();s.refresh(x);return test_out(s,x)
@app.patch('/tests/{test_id}',dependencies=[Depends(auth)])
def update_test(test_id:int,v:TestUpdateIn,s:Session=Depends(db)):
    x=get_or_404(s,Test,test_id)
    new_url=v.target_url if v.target_url is not None else x.target_url
    new_steps=clean_steps(v.steps) if v.steps is not None else json.loads(x.steps or '[]')
    check_test_urls(new_url,new_steps)
    if v.name is not None:x.name=v.name
    x.target_url=new_url;x.steps=json.dumps(new_steps)
    s.commit();s.refresh(x);return test_out(s,x)
@app.delete('/tests/{test_id}',dependencies=[Depends(auth)])
def delete_test(test_id:int,s:Session=Depends(db)):
    x=get_or_404(s,Test,test_id)
    for r in s.scalars(select(TestRun).where(TestRun.test_id==test_id)):s.delete(r)
    s.delete(x);s.commit();return {'deleted':test_id}
@app.post('/tests/{test_id}/run',dependencies=[Depends(auth)])
def run_test(test_id:int,v:RunIn,s:Session=Depends(db)):
    x=get_or_404(s,Test,test_id)
    if v.release_id:get_or_404(s,Release,v.release_id)
    steps=json.loads(x.steps or '[]')
    check_test_urls(x.target_url,steps)  # re-check: policy may have changed since the test was saved
    node=node_bin()
    if not node:raise HTTPException(500,'Node.js not found on server; required to run tests')
    if not RUNNER.exists():raise HTTPException(500,'Test runner is missing')
    run=TestRun(test_id=test_id,release_id=v.release_id,status='Pending');s.add(run);s.commit();s.refresh(run)
    out_dir=TESTRUN_DIR/str(run.id);out_dir.mkdir(parents=True,exist_ok=True)
    spec={'target_url':x.target_url,'steps':steps,'out_dir':str(out_dir),'default_timeout':15000,'allowed_hosts':ALLOWED_TEST_HOSTS}
    cp=os.getenv('CHROME_PATH')
    if cp:spec['chrome_path']=cp
    spec_path=out_dir/'spec.json';spec_path.write_text(json.dumps(spec))
    try:
        proc=subprocess.run([node,str(RUNNER),str(spec_path)],capture_output=True,text=True,timeout=180)
        data=json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {'status':'Error','error':(proc.stderr or 'no output')[-500:]}
    except subprocess.TimeoutExpired:
        data={'status':'Error','error':'Test run timed out after 180s','steps':[],'screenshots':[],'console_errors':[]}
    except Exception as e:
        data={'status':'Error','error':str(e),'steps':[],'screenshots':[],'console_errors':[]}
    run.status=data.get('status','Error');run.duration_ms=data.get('duration_ms',0)
    run.steps_log=json.dumps(data.get('steps',[]));run.screenshots=json.dumps(data.get('screenshots',[]))
    run.console_errors=json.dumps(data.get('console_errors',[]));run.error=data.get('error') or ''
    s.commit();s.refresh(run);return run_out(run)
@app.get('/test-runs',dependencies=[Depends(auth)])
def list_runs(test_id:Optional[int]=None,application_id:Optional[int]=None,s:Session=Depends(db)):
    q=select(TestRun).join(Test).join(Feature,Test.feature_id==Feature.id)
    if test_id:q=q.where(TestRun.test_id==test_id)
    if application_id:q=q.where(Feature.application_id==application_id)
    return [run_out(x) for x in s.scalars(q.order_by(TestRun.id.desc()).limit(100))]
@app.get('/test-runs/{run_id}/artifact/{name}',dependencies=[Depends(auth)])
def run_artifact(run_id:int,name:str,s:Session=Depends(db)):
    get_or_404(s,TestRun,run_id)
    if '/' in name or '\\' in name or '..' in name:raise HTTPException(400,'Invalid name')
    p=TESTRUN_DIR/str(run_id)/name
    if not p.exists():raise HTTPException(404,'Artifact not found')
    return FileResponse(p,media_type='image/png')
def parse_text_tests(content:str,default_url:str):
    """Parse a simple line-based test-case format into test dicts.
    `test: <name>` starts a test, `url: <url>` sets its target, other lines are steps:
    goto <url> | wait <ms> | click <sel> | waitFor <sel> [~ text] | expectVisible <sel>
    expectText [<sel> ~] <text> | fill <sel> = <value> | screenshot <name>"""
    tests=[];cur=None
    def flush():
        if cur and cur['steps']:tests.append(cur)
    for line in content.splitlines():
        line=line.strip()
        if not line or line.startswith('#'):continue
        low=line.lower()
        if low.startswith('test:'):
            flush();cur={'name':line.split(':',1)[1].strip() or f'Test {len(tests)+1}','target_url':default_url,'steps':[]};continue
        if cur is None:cur={'name':'Imported test','target_url':default_url,'steps':[]}
        if low.startswith('url:'):cur['target_url']=line.split(':',1)[1].strip();continue
        parts=line.split(None,1);action=parts[0];rest=parts[1].strip() if len(parts)>1 else ''
        amap={'goto':'goto','wait':'wait','click':'click','waitfor':'waitFor','expectvisible':'expectVisible','expecttext':'expectText','fill':'fill','screenshot':'screenshot'}
        act=amap.get(action.lower())
        if not act:continue
        if act=='goto':cur['steps'].append({'action':'goto','url':rest})
        elif act=='wait':cur['steps'].append({'action':'wait','timeout':int(re.sub(r'\D','',rest) or '1000')})
        elif act=='screenshot':cur['steps'].append({'action':'screenshot','name':rest or 'shot'})
        elif act in ('click','expectVisible'):cur['steps'].append({'action':act,'selector':rest})
        elif act=='waitFor':
            if '~' in rest:sel,txt=rest.split('~',1);cur['steps'].append({'action':'waitFor','selector':sel.strip(),'text':txt.strip()})
            else:cur['steps'].append({'action':'waitFor','selector':rest})
        elif act=='fill':
            if '=' in rest:sel,val=rest.split('=',1);cur['steps'].append({'action':'fill','selector':sel.strip(),'value':val.strip()})
        elif act=='expectText':
            if '~' in rest:sel,txt=rest.split('~',1);cur['steps'].append({'action':'expectText','selector':sel.strip(),'text':txt.strip()})
            else:cur['steps'].append({'action':'expectText','text':rest})
    flush();return tests
@app.post('/tests/import',dependencies=[Depends(auth)])
def import_tests(v:ImportIn,s:Session=Depends(db)):
    get_or_404(s,Application,v.application_id)
    raw=[];fmt=v.format
    text=v.content.strip()
    if fmt=='auto':fmt='json' if text[:1] in '[{' else 'text'
    if fmt=='json':
        try:parsed=json.loads(text)
        except Exception as e:raise HTTPException(400,f'Invalid JSON: {e}')
        for t in (parsed if isinstance(parsed,list) else [parsed]):
            raw.append({'name':t.get('name') or 'Imported test','target_url':t.get('target_url') or v.target_url,'steps':t.get('steps') or [],'feature_id':t.get('feature_id')})
    else:
        for t in parse_text_tests(text,v.target_url):raw.append({**t,'feature_id':None})
    if not raw:raise HTTPException(400,'No test cases could be parsed')
    created=[]
    for t in raw:
        fid=t.get('feature_id') or v.feature_id
        if not fid:raise HTTPException(400,'A feature must be selected (or provided per test) to import into')
        get_or_404(s,Feature,fid)
        if not (t['target_url'] or '').strip():raise HTTPException(400,f"Test '{t['name']}' has no target URL")
        t_steps=clean_steps(t['steps']);check_test_urls(t['target_url'],t_steps)
        x=Test(feature_id=fid,name=t['name'][:200],target_url=t['target_url'][:2000],steps=json.dumps(t_steps))
        s.add(x);created.append(x)
    s.commit()
    for x in created:s.refresh(x)
    return {'imported':len(created),'tests':[test_out(s,x) for x in created]}
